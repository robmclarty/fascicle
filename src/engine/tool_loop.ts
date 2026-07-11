/**
 * Tool-call loop orchestration (spec §6.4).
 *
 * Invariants:
 *   - Tools execute SEQUENTIALLY within a turn (no parallel dispatch).
 *   - Abort is checked at the top of each loop iteration AND before each tool
 *     call within a turn.
 *   - Tool input is validated against tool.input_schema BEFORE execute is
 *     invoked. Invalid input is fed back as a tool result with error: true and
 *     consumes a step; execute is not called.
 *   - tool_error_policy:
 *       'feed_back' (default) serializes the thrown error into a tool result
 *           with { error: <message> }. Loop continues.
 *       'throw' wraps the error in tool_error and ends the call.
 *   - needs_approval (boolean or predicate) gates execute. Abort fired during
 *     the await rejects with aborted_error.
 *   - Absent on_tool_approval with needs_approval truthy FAILS CLOSED
 *     (tool_approval_denied_error thrown before execute).
 *   - max_steps cap RESOLVES with finish_reason: 'max_steps' (does not throw).
 *     Attempted-but-unexecuted tool calls from the final turn land in
 *     tool_calls with error: { message: 'max_steps_exceeded_before_execution' }.
 *   - salvage_budget (from tool_call_repair_attempts): a turn with NO
 *     structured calls, finish_reason 'stop'|'length', and tools present is
 *     scanned for calls the model emitted as text (a local-runtime failure).
 *     Validated matches run the normal execute path and produce the same
 *     records/events/chunks as native calls, marked salvaged. The budget is
 *     a shared mutable holder so it spans schema-repair re-invocations.
 *   - max_tool_calls_per_step: calls beyond the cap are dropped for the step
 *     (the model can re-issue next turn), recorded with
 *     error: { message: 'dropped_max_tool_calls_per_step' }, and excluded
 *     from the assistant history message so providers that require a result
 *     per emitted call do not reject the next request.
 *   - ends_turn (Tool.ends_turn): a tool flagged terminal ends the loop when a
 *     call to it executes SUCCESSFULLY. The call runs the normal execute path
 *     (record, fed tool_result message, trajectory events + chunk), then the
 *     loop breaks with finish_reason 'stop' instead of running another model
 *     turn. Salvaged terminal calls behave identically. A denied, invalid,
 *     dropped, or throwing terminal call does NOT end the loop. A successful
 *     terminal call is exempt from the max_steps would_exceed_after skip (it
 *     needs no follow-up turn), so a terminal finish wins over a coincident
 *     max_steps cap (finish_reason 'stop', max_steps_reached false).
 *
 * The loop does not itself call the AI SDK. It invokes a supplied `invoke_once`
 * seam that returns a neutral TurnResult. generate.ts builds the real seam
 * (the ai_sdk transport in providers/ai_sdk/, or a native adapter's
 * invoke_turn); tests inject a mock seam directly.
 */

import type { z } from 'zod'
import type { TrajectoryLogger } from '#core'
import type {
  CostBreakdown,
  FinishReason,
  Message,
  PrepareStepHook,
  Pricing,
  SalvageFormat,
  StepRecord,
  StreamChunk,
  Tool,
  ToolApprovalHandler,
  ToolCallRecord,
  ToolExecContext,
  TurnResult,
  UsageTotals,
} from './types.js'
import { salvage_tool_calls, type SalvageOutcome } from './tool_call_salvage.js'
import {
  aborted_error,
  tool_approval_denied_error,
  tool_error,
} from './errors.js'
import {
  record_cost,
  record_tool_approval,
  record_tool_call,
  record_tool_call_salvaged,
  record_tool_calls_dropped,
  record_tool_result,
  end_step_span,
  start_step_span,
  type PricingMissingDedup,
} from './trajectory.js'
import { compute_cost, FREE_PROVIDERS } from './pricing.js'

export type InvokeOnceArgs = {
  readonly step_index: number
  readonly messages: ReadonlyArray<Message>
  readonly tools: ReadonlyArray<Tool>
  readonly abort: AbortSignal
  readonly stream: boolean
}

export type RawToolCall = {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

/**
 * Retained alias of the neutral TurnResult (types.ts). Callers built against
 * the loop-local name keep working while TurnResult is the shared spelling.
 */
export type InvokeOnceResult = TurnResult

export type InvokeOnce = (args: InvokeOnceArgs) => Promise<TurnResult>

export type ToolLoopConfig = {
  readonly invoke_once: InvokeOnce
  readonly messages: Message[]
  readonly tools: ReadonlyArray<Tool>
  readonly max_steps: number
  readonly step_index_start: number
  readonly tool_error_policy: 'feed_back' | 'throw'
  readonly abort: AbortSignal
  readonly on_tool_approval: ToolApprovalHandler | undefined
  readonly trajectory: TrajectoryLogger | undefined
  readonly stream: boolean
  readonly dispatch_chunk: ((chunk: StreamChunk) => Promise<void>) | undefined
  readonly provider: string
  readonly model_id: string
  readonly resolve_pricing: () => Pricing | undefined
  readonly pricing_dedup: PricingMissingDedup
  readonly on_finish_step?: (record: StepRecord) => void
  /**
   * Per-turn message hook (D6). Called before each turn with the would-be
   * request messages; a returned `{ messages }` replaces the request for THAT
   * turn only (config.messages, the canonical transcript, is untouched).
   * undefined disables the hook.
   */
  readonly prepare_step?: PrepareStepHook
  /**
   * Mutable so the budget survives schema-repair re-invocations of the loop
   * within one generate call (precedent: pricing_dedup). undefined = salvage
   * disabled.
   */
  readonly salvage_budget?: { remaining: number }
  readonly max_tool_calls_per_step?: number
}

export type ToolLoopResult = {
  readonly text: string
  readonly steps: StepRecord[]
  readonly tool_calls: ToolCallRecord[]
  readonly finish_reason: FinishReason
  readonly max_steps_reached: boolean
}

function throw_if_aborted(abort: AbortSignal, step_index: number): void {
  if (!abort.aborted) return
  throw new aborted_error('aborted', { reason: abort.reason, step_index })
}

function throw_if_aborted_in_flight(
  abort: AbortSignal,
  step_index: number,
  tool_call: { id: string; name: string },
): void {
  if (!abort.aborted) return
  throw new aborted_error('aborted', {
    reason: abort.reason,
    step_index,
    tool_call_in_flight: { id: tool_call.id, name: tool_call.name },
  })
}

function serialize_error(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

async function request_approval(
  tool: Tool,
  input: unknown,
  step_index: number,
  tool_call_id: string,
  abort: AbortSignal,
  on_tool_approval: ToolApprovalHandler | undefined,
  trajectory: TrajectoryLogger | undefined,
): Promise<boolean> {
  const needs_approval = tool.needs_approval
  const needs =
    typeof needs_approval === 'function'
      ? await needs_approval(input)
      : needs_approval === true
  if (!needs) return true

  record_tool_approval(trajectory, 'tool_approval_requested', {
    tool_name: tool.name,
    step_index,
    tool_call_id,
  })

  if (on_tool_approval === undefined) {
    record_tool_approval(trajectory, 'tool_approval_denied', {
      tool_name: tool.name,
      step_index,
      tool_call_id,
    })
    throw new tool_approval_denied_error(
      `tool approval required for '${tool.name}' but no on_tool_approval handler was provided`,
      { tool_name: tool.name, step_index, tool_call_id },
    )
  }

  const approval_promise = Promise.resolve(
    on_tool_approval({ tool_name: tool.name, input, step_index, abort }),
  )

  const approved = await new Promise<boolean>((resolve, reject) => {
    if (abort.aborted) {
      reject(new aborted_error('aborted', { reason: abort.reason, step_index }))
      return
    }
    const on_abort = (): void => {
      reject(new aborted_error('aborted', { reason: abort.reason, step_index }))
    }
    abort.addEventListener('abort', on_abort, { once: true })
    approval_promise.then(
      (value) => {
        abort.removeEventListener('abort', on_abort)
        resolve(value)
      },
      (err: unknown) => {
        abort.removeEventListener('abort', on_abort)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })

  record_tool_approval(
    trajectory,
    approved ? 'tool_approval_granted' : 'tool_approval_denied',
    { tool_name: tool.name, step_index, tool_call_id },
  )

  return approved
}

async function dispatch_tool_result_chunk(
  dispatch_chunk: ((chunk: StreamChunk) => Promise<void>) | undefined,
  step_index: number,
  id: string,
  output?: unknown,
  error?: { message: string },
): Promise<void> {
  if (dispatch_chunk === undefined) return
  const chunk: StreamChunk = { kind: 'tool_result', id, step_index }
  if (output !== undefined) chunk.output = output
  if (error !== undefined) chunk.error = error
  await dispatch_chunk(chunk)
}

function build_tool_result_message(
  tool_call_id: string,
  tool_name: string,
  content: unknown,
): Message {
  const serialized =
    typeof content === 'string' ? content : safe_json_stringify(content)
  return {
    role: 'tool',
    tool_call_id,
    name: tool_name,
    content: serialized,
  }
}

function safe_json_stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function build_assistant_message(text: string, tool_calls: ReadonlyArray<RawToolCall>): Message {
  if (tool_calls.length === 0) return { role: 'assistant', content: text }
  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_call'; id: string; name: string; input: unknown }
  > = []
  if (text.length > 0) parts.push({ type: 'text', text })
  for (const tc of tool_calls) {
    parts.push({ type: 'tool_call', id: tc.id, name: tc.name, input: tc.input })
  }
  return { role: 'assistant', content: parts }
}

function compute_and_record_cost(
  config: ToolLoopConfig,
  step_index: number,
  usage: UsageTotals,
): CostBreakdown | undefined {
  const pricing = config.resolve_pricing()
  if (pricing === undefined && !FREE_PROVIDERS.has(config.provider)) {
    config.pricing_dedup.emit(config.provider, config.model_id)
    return undefined
  }
  const breakdown = compute_cost(usage, pricing, config.provider)
  if (breakdown !== undefined) {
    record_cost(config.trajectory, step_index, breakdown, 'engine_derived')
  }
  return breakdown
}

function validate_tool_input(
  tool: Tool,
  input: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  // The schema field is typed as z.ZodType<i>; we call safeParse in the
  // runtime position where the input has not been narrowed.
  const schema: z.ZodType = tool.input_schema
  const parsed = schema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  const error_message = serialize_error(parsed.error)
  return { ok: false, message: `invalid tool input: ${error_message}` }
}

/**
 * Apply the prepare_step hook (D6) for one turn. Returns the messages to send
 * to the transport: the hook's replacement when it returns `{ messages }`, else
 * config.messages unchanged. The replacement is ephemeral — it is fed ONLY to
 * invoke_once for this turn, never pushed onto config.messages, so the loop's
 * salvage/approval/ends_turn/schema-repair machinery keeps reading the real
 * transcript. A step_prepared event (recorded inline, as request_sent is) makes
 * the mid-loop mutation legible with the before/after message counts.
 */
async function apply_prepare_step(
  config: ToolLoopConfig,
  step_index: number,
): Promise<ReadonlyArray<Message>> {
  if (config.prepare_step === undefined) return config.messages
  const prepared = await config.prepare_step({
    step_index,
    messages: config.messages,
  })
  const replacement = prepared?.messages
  if (replacement === undefined) return config.messages
  config.trajectory?.record({
    kind: 'step_prepared',
    step_index,
    message_count_before: config.messages.length,
    message_count_after: replacement.length,
  })
  return replacement
}

export async function run_tool_loop(config: ToolLoopConfig): Promise<ToolLoopResult> {
  const steps: StepRecord[] = []
  const tool_calls_all: ToolCallRecord[] = []
  let text = ''
  let finish_reason: FinishReason = 'stop'
  let step_index = config.step_index_start
  let max_steps_reached = false

  const tool_map = new Map<string, Tool>()
  for (const t of config.tools) tool_map.set(t.name, t)

  while (true) {
    throw_if_aborted(config.abort, step_index)

    if (step_index >= config.max_steps) {
      max_steps_reached = true
      finish_reason = 'max_steps'
      break
    }

    const step_span = start_step_span(config.trajectory, step_index)

    let turn: TurnResult
    try {
      const request_messages = await apply_prepare_step(config, step_index)
      config.trajectory?.record({ kind: 'request_sent', step_index })
      turn = await config.invoke_once({
        step_index,
        messages: request_messages,
        tools: config.tools,
        abort: config.abort,
        stream: config.stream,
      })
      config.trajectory?.record({
        kind: 'response_received',
        step_index,
        output_tokens: turn.usage.output_tokens,
        finish_reason: turn.finish_reason,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      end_step_span(config.trajectory, step_span, { error: message })
      throw err
    }

    // A turn that "stopped" with plain text may hold a call the runtime
    // failed to parse into tool_calls; salvage before deciding the step ends
    // the loop. History gets the stripped text + structured parts (raw markup
    // in history would teach the model the text format works, and a tool
    // result without a matching call part is rejected by OpenAI-compatible
    // APIs); StepRecord.text keeps the raw text for debugging.
    let effective_calls: ReadonlyArray<RawToolCall> = turn.tool_calls
    let history_text = turn.text
    let salvage: SalvageOutcome | undefined
    const salvaged_formats = new Map<string, SalvageFormat>()
    if (
      turn.tool_calls.length === 0 &&
      (turn.finish_reason === 'stop' || turn.finish_reason === 'length') &&
      config.tools.length > 0 &&
      config.salvage_budget !== undefined &&
      config.salvage_budget.remaining > 0
    ) {
      salvage = salvage_tool_calls(turn.text, tool_map)
      if (salvage !== undefined) {
        config.salvage_budget.remaining -= 1
        history_text = salvage.stripped_text
        effective_calls = salvage.calls.map((c, n) => {
          const id = `salvaged_${step_index}_${n}`
          salvaged_formats.set(id, c.format)
          return { id, name: c.name, input: c.input }
        })
        record_tool_call_salvaged(config.trajectory, {
          step_index,
          calls: effective_calls.map((c) => ({
            tool_call_id: c.id,
            name: c.name,
            format: salvaged_formats.get(c.id) ?? 'json',
          })),
          raw_text: turn.text,
        })
        if (config.dispatch_chunk !== undefined) {
          // Mirror the native stream, which emits start/end for every call
          // the model attempted, including ones the clamp below drops.
          for (const c of effective_calls) {
            await config.dispatch_chunk({
              kind: 'tool_call_start',
              id: c.id,
              name: c.name,
              step_index,
            })
            await config.dispatch_chunk({
              kind: 'tool_call_end',
              id: c.id,
              input: c.input,
              step_index,
            })
          }
        }
      }
    }

    // Clamp applies to native and salvaged calls alike. Dropped calls never
    // reach history; the model re-issues them on a later turn if it still
    // wants them.
    let dropped_calls: ReadonlyArray<RawToolCall> = []
    const per_step_cap = config.max_tool_calls_per_step
    if (per_step_cap !== undefined && effective_calls.length > per_step_cap) {
      dropped_calls = effective_calls.slice(per_step_cap)
      effective_calls = effective_calls.slice(0, per_step_cap)
      record_tool_calls_dropped(config.trajectory, {
        step_index,
        max_tool_calls_per_step: per_step_cap,
        kept: effective_calls.length,
        dropped: dropped_calls.map((d) => ({ tool_call_id: d.id, name: d.name })),
      })
    }

    const step_tool_records: ToolCallRecord[] = []
    const assistant_message = build_assistant_message(history_text, effective_calls)
    config.messages.push(assistant_message)

    if (effective_calls.length === 0) {
      text = turn.text
      finish_reason = turn.finish_reason
      const record_step: StepRecord = {
        index: step_index,
        text: turn.text,
        tool_calls: [],
        usage: turn.usage,
        finish_reason: turn.finish_reason,
      }
      const breakdown = compute_and_record_cost(config, step_index, turn.usage)
      if (breakdown !== undefined) record_step.cost = breakdown
      steps.push(record_step)
      if (config.on_finish_step !== undefined) config.on_finish_step(record_step)
      end_step_span(config.trajectory, step_span, {
        usage: turn.usage,
        finish_reason: turn.finish_reason,
      })
      break
    }

    // This turn has tool calls. Execute them sequentially.
    const would_exceed_after = step_index + 1 >= config.max_steps
    const tool_results_to_feed: Message[] = []
    // Set true when a call to a Tool flagged ends_turn executes successfully;
    // ends the loop after this step (see the terminal-finish break below).
    let terminal_fired = false

    for (const raw_call of effective_calls) {
      throw_if_aborted_in_flight(config.abort, step_index, { id: raw_call.id, name: raw_call.name })

      // A successful terminal call needs no follow-up turn, so it is exempt
      // from this skip: it executes below and ends the loop cleanly, winning
      // over the coincident max_steps cap.
      if (would_exceed_after && tool_map.get(raw_call.name)?.ends_turn !== true) {
        const record: ToolCallRecord = {
          id: raw_call.id,
          name: raw_call.name,
          input: raw_call.input,
          error: { message: 'max_steps_exceeded_before_execution' },
          duration_ms: 0,
          started_at: Date.now(),
        }
        step_tool_records.push(record)
        tool_calls_all.push(record)
        await dispatch_tool_result_chunk(
          config.dispatch_chunk,
          step_index,
          raw_call.id,
          undefined,
          { message: 'max_steps_exceeded_before_execution' },
        )
        continue
      }

      const tool = tool_map.get(raw_call.name)
      if (tool === undefined) {
        const err_message = `unknown tool '${raw_call.name}'`
        if (config.tool_error_policy === 'throw') {
          const thrown = new tool_error(err_message, {
            tool_name: raw_call.name,
            tool_call_id: raw_call.id,
            cause: new Error(err_message),
          })
          end_step_span(config.trajectory, step_span, { error: err_message })
          throw thrown
        }
        const record: ToolCallRecord = {
          id: raw_call.id,
          name: raw_call.name,
          input: raw_call.input,
          error: { message: err_message },
          duration_ms: 0,
          started_at: Date.now(),
        }
        step_tool_records.push(record)
        tool_calls_all.push(record)
        tool_results_to_feed.push(
          build_tool_result_message(raw_call.id, raw_call.name, {
            error: err_message,
          }),
        )
        record_tool_call(config.trajectory, {
          step_index,
          name: raw_call.name,
          tool_call_id: raw_call.id,
          input: raw_call.input,
          duration_ms: 0,
          error: { message: err_message },
        })
        await dispatch_tool_result_chunk(
          config.dispatch_chunk,
          step_index,
          raw_call.id,
          undefined,
          { message: err_message },
        )
        continue
      }

      const validation = validate_tool_input(tool, raw_call.input)
      if (!validation.ok) {
        const record: ToolCallRecord = {
          id: raw_call.id,
          name: raw_call.name,
          input: raw_call.input,
          error: { message: validation.message },
          duration_ms: 0,
          started_at: Date.now(),
        }
        step_tool_records.push(record)
        tool_calls_all.push(record)
        tool_results_to_feed.push(
          build_tool_result_message(raw_call.id, raw_call.name, {
            error: validation.message,
          }),
        )
        record_tool_call(config.trajectory, {
          step_index,
          name: raw_call.name,
          tool_call_id: raw_call.id,
          input: raw_call.input,
          duration_ms: 0,
          error: { message: validation.message },
        })
        await dispatch_tool_result_chunk(
          config.dispatch_chunk,
          step_index,
          raw_call.id,
          undefined,
          { message: validation.message },
        )
        continue
      }

      let approved: boolean
      try {
        approved = await request_approval(
          tool,
          validation.value,
          step_index,
          raw_call.id,
          config.abort,
          config.on_tool_approval,
          config.trajectory,
        )
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        end_step_span(config.trajectory, step_span, { error: message })
        throw err
      }

      if (!approved) {
        const denied_message = 'tool_approval_denied'
        if (config.tool_error_policy === 'throw') {
          const thrown = new tool_approval_denied_error(
            `tool '${tool.name}' approval denied`,
            { tool_name: tool.name, step_index, tool_call_id: raw_call.id },
          )
          end_step_span(config.trajectory, step_span, { error: denied_message })
          throw thrown
        }
        const record: ToolCallRecord = {
          id: raw_call.id,
          name: tool.name,
          input: validation.value,
          error: { message: denied_message },
          duration_ms: 0,
          started_at: Date.now(),
        }
        step_tool_records.push(record)
        tool_calls_all.push(record)
        tool_results_to_feed.push(
          build_tool_result_message(raw_call.id, tool.name, { error: denied_message }),
        )
        record_tool_call(config.trajectory, {
          step_index,
          name: tool.name,
          tool_call_id: raw_call.id,
          input: validation.value,
          duration_ms: 0,
          error: { message: denied_message },
        })
        await dispatch_tool_result_chunk(
          config.dispatch_chunk,
          step_index,
          raw_call.id,
          undefined,
          { message: denied_message },
        )
        continue
      }

      throw_if_aborted_in_flight(config.abort, step_index, {
        id: raw_call.id,
        name: tool.name,
      })

      const started_at = Date.now()
      const tool_ctx: ToolExecContext = {
        abort: config.abort,
        tool_call_id: raw_call.id,
        step_index,
        ...(config.trajectory !== undefined ? { trajectory: config.trajectory } : {}),
      }

      let output: unknown
      let err_message: string | undefined
      let thrown: unknown
      try {
        const execute = tool.execute
        const maybe = execute(validation.value, tool_ctx)
        output = maybe instanceof Promise ? await maybe : maybe
      } catch (err: unknown) {
        thrown = err
        err_message = serialize_error(err)
      }

      const duration_ms = Date.now() - started_at

      if (thrown !== undefined) {
        if (config.abort.aborted) {
          const abort_err = new aborted_error('aborted', {
            reason: config.abort.reason,
            step_index,
            tool_call_in_flight: { id: raw_call.id, name: tool.name },
          })
          end_step_span(config.trajectory, step_span, { error: 'aborted' })
          throw abort_err
        }
        if (config.tool_error_policy === 'throw') {
          const wrapped = new tool_error(`tool '${tool.name}' failed: ${err_message ?? 'unknown'}`, {
            tool_name: tool.name,
            tool_call_id: raw_call.id,
            cause: thrown,
          })
          end_step_span(config.trajectory, step_span, { error: err_message ?? 'tool error' })
          throw wrapped
        }
        const record: ToolCallRecord = {
          id: raw_call.id,
          name: tool.name,
          input: validation.value,
          error: { message: err_message ?? 'unknown' },
          duration_ms,
          started_at,
        }
        step_tool_records.push(record)
        tool_calls_all.push(record)
        tool_results_to_feed.push(
          build_tool_result_message(raw_call.id, tool.name, { error: err_message ?? 'unknown' }),
        )
        record_tool_call(config.trajectory, {
          step_index,
          name: tool.name,
          tool_call_id: raw_call.id,
          input: validation.value,
          duration_ms,
          error: { message: err_message ?? 'unknown' },
        })
        await dispatch_tool_result_chunk(
          config.dispatch_chunk,
          step_index,
          raw_call.id,
          undefined,
          { message: err_message ?? 'unknown' },
        )
        continue
      }

      const record: ToolCallRecord = {
        id: raw_call.id,
        name: tool.name,
        input: validation.value,
        output,
        duration_ms,
        started_at,
      }
      step_tool_records.push(record)
      tool_calls_all.push(record)
      if (tool.ends_turn === true) terminal_fired = true
      tool_results_to_feed.push(
        build_tool_result_message(raw_call.id, tool.name, output ?? ''),
      )
      record_tool_call(config.trajectory, {
        step_index,
        name: tool.name,
        tool_call_id: raw_call.id,
        input: validation.value,
        duration_ms,
      })
      await dispatch_tool_result_chunk(config.dispatch_chunk, step_index, raw_call.id, output)
    }

    // Dropped calls mirror the max_steps precedent: a record with an error
    // and a tool_result event/chunk, but no tool_call event, no execution,
    // and no fed-back tool message (their call parts are not in history).
    for (const d of dropped_calls) {
      const record: ToolCallRecord = {
        id: d.id,
        name: d.name,
        input: d.input,
        error: { message: 'dropped_max_tool_calls_per_step' },
        duration_ms: 0,
        started_at: Date.now(),
      }
      step_tool_records.push(record)
      tool_calls_all.push(record)
      await dispatch_tool_result_chunk(
        config.dispatch_chunk,
        step_index,
        d.id,
        undefined,
        { message: 'dropped_max_tool_calls_per_step' },
      )
    }

    for (const r of step_tool_records) {
      const format = salvaged_formats.get(r.id)
      if (format !== undefined) {
        r.salvaged = true
        r.salvaged_format = format
      }
    }

    // Emit a tool_result for every resolved call in this step (success carries
    // output, feed-back failures carry error). Throw-policy and aborted calls
    // exit before here and surface loudly as a thrown error instead.
    for (const r of step_tool_records) {
      record_tool_result(config.trajectory, {
        step_index,
        name: r.name,
        tool_call_id: r.id,
        duration_ms: r.duration_ms,
        ...(r.error !== undefined ? { error: r.error } : { output: r.output }),
      })
    }

    for (const m of tool_results_to_feed) config.messages.push(m)

    // A salvaged step reports 'tool_calls': downstream consumers see the same
    // shape a native tool turn produces; the salvaged flags carry provenance.
    // A terminal step reports 'tool_calls' (it genuinely made calls); the loop
    // finish_reason 'stop' below is the separate signal that generation ended.
    const turn_finish_reason: FinishReason = terminal_fired
      ? 'tool_calls'
      : would_exceed_after
        ? 'max_steps'
        : salvage !== undefined
          ? 'tool_calls'
          : turn.finish_reason
    const step_record: StepRecord = {
      index: step_index,
      text: turn.text,
      tool_calls: step_tool_records,
      usage: turn.usage,
      finish_reason: turn_finish_reason,
    }
    const breakdown = compute_and_record_cost(config, step_index, turn.usage)
    if (breakdown !== undefined) step_record.cost = breakdown
    steps.push(step_record)
    if (config.on_finish_step !== undefined) config.on_finish_step(step_record)
    end_step_span(config.trajectory, step_span, {
      usage: turn.usage,
      finish_reason: turn_finish_reason,
    })

    // A successful terminal call ends the loop cleanly. Placed before the
    // max_steps break so a terminal finish wins over a coincident cap: the
    // full step is already recorded, so the result stays complete.
    if (terminal_fired) {
      finish_reason = 'stop'
      text = turn.text
      break
    }

    if (would_exceed_after) {
      max_steps_reached = true
      finish_reason = 'max_steps'
      text = turn.text
      break
    }

    step_index += 1
  }

  return { text, steps, tool_calls: tool_calls_all, finish_reason, max_steps_reached }
}
