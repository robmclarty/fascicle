/**
 * Tool-call loop orchestration.
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

import { format_schema_issues, validate_schema } from '#schema'
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
   * Per-turn message hook. Called before each turn with the would-be request
   * messages; a returned `{ messages }` replaces the request for THAT turn
   * only (config.messages, the canonical transcript, is untouched).
   * undefined disables the hook.
   */
  readonly prepare_step?: PrepareStepHook
  /**
   * Mutable so the budget survives schema-repair re-invocations of the loop
   * within one generate call, the same threading pattern as pricing_dedup.
   * undefined disables salvage.
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

/**
 * Throw `aborted_error` (tagged with the step index) if the signal has fired.
 */
function throw_if_aborted(abort: AbortSignal, step_index: number): void {
  if (!abort.aborted) return
  throw new aborted_error('aborted', { reason: abort.reason, step_index })
}

/**
 * Like `throw_if_aborted`, but names the tool call that was about to run so
 * the error shows exactly where the abort landed.
 */
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

/**
 * Reduce any thrown value to a message string, never throwing itself.
 */
function serialize_error(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

/**
 * Resolve whether a tool call may execute.
 *
 * Evaluates `needs_approval` (boolean or async predicate); when approval is
 * required, records the request event and awaits the handler in a race
 * against `abort`. A missing handler fails closed with
 * `tool_approval_denied_error` so approval-gated tools never run silently.
 */
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
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: { once: true } is a cleanup optimization; the abort event is terminal and both then-handlers removeEventListener, so once:false is unobservable.
    abort.addEventListener('abort', on_abort, { once: true })
    approval_promise.then(
      (value) => {
        // Stryker disable next-line StringLiteral: removing the listener on the settled promise is cleanup only; an empty event name leaks a listener that can never fire observably.
        abort.removeEventListener('abort', on_abort)
        resolve(value)
      },
      (err: unknown) => {
        // Stryker disable next-line StringLiteral: same cleanup-only removal on the reject path.
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

/**
 * Emit a `tool_result` stream chunk when streaming is active.
 */
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

/**
 * Build the `role: 'tool'` message that feeds a tool's result back to the
 * model, JSON-serializing non-string content.
 */
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

/**
 * JSON-stringify with a `String(value)` fallback for circular references and
 * other values `JSON.stringify` rejects.
 */
function safe_json_stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Build the assistant history message for a turn: plain text when there are
 * no tool calls, otherwise structured text plus tool_call parts.
 */
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

/**
 * Derive the step's cost from pricing tables and record it.
 *
 * Missing pricing for a paid provider emits `pricing_missing` (deduped per
 * call) and yields no breakdown; free providers skip the emit entirely.
 */
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

/**
 * Validate a raw tool-call input against the tool's schema before execution,
 * returning the parsed value or a feedback-ready error message.
 */
async function validate_tool_input(
  tool: Tool,
  input: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const parsed = await validate_schema(tool.input_schema, input)
  if (parsed.ok) return { ok: true, value: parsed.value }
  return { ok: false, message: `invalid tool input: ${format_schema_issues(parsed.issues)}` }
}

/**
 * Apply the prepare_step hook for one turn. Returns the messages to send to
 * the transport: the hook's replacement when it returns `{ messages }`, else
 * config.messages unchanged. The replacement is ephemeral; it is fed ONLY to
 * invoke_once for this turn, never pushed onto config.messages, so the loop's
 * salvage/approval/ends_turn/schema-repair machinery keeps reading the real
 * transcript. A step_prepared event (recorded inline, as request_sent is)
 * makes the mid-loop mutation legible with the before/after message counts.
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

/**
 * Mutable accumulators shared across loop iterations: the step records and
 * the flat list of every tool call the loop resolved.
 */
type LoopAccumulator = {
  readonly steps: StepRecord[]
  readonly tool_calls: ToolCallRecord[]
}

/**
 * Per-step working state threaded through the call-execution helpers.
 * `records` and `feed` accumulate in call order; `all_records` aliases the
 * loop-wide accumulator; `terminal_fired` flips when a call to a Tool
 * flagged ends_turn executes successfully (see the header invariant).
 */
type StepContext = {
  readonly config: ToolLoopConfig
  readonly tool_map: ReadonlyMap<string, Tool>
  readonly step_index: number
  readonly step_span: string | undefined
  readonly would_exceed_after: boolean
  readonly records: ToolCallRecord[]
  readonly all_records: ToolCallRecord[]
  readonly feed: Message[]
  terminal_fired: boolean
}

/**
 * One turn's effective view of the model output after salvage: the calls to
 * execute, the text history should carry, and the per-call salvage formats.
 * `outcome` is undefined when no salvage applied (native calls pass through).
 */
type SalvageView = {
  readonly calls: ReadonlyArray<RawToolCall>
  readonly history_text: string
  readonly formats: ReadonlyMap<string, SalvageFormat>
  readonly outcome: SalvageOutcome | undefined
}

/**
 * Assemble the loop's return value from the accumulated steps and records.
 */
function loop_result(
  acc: LoopAccumulator,
  text: string,
  finish_reason: FinishReason,
  max_steps_reached: boolean,
): ToolLoopResult {
  return { text, steps: acc.steps, tool_calls: acc.tool_calls, finish_reason, max_steps_reached }
}

/**
 * Invoke the transport seam once for one turn, bracketed by request_sent /
 * response_received events. A thrown invoke (or prepare_step) closes the
 * step span with the error before rethrowing.
 */
async function invoke_turn(
  config: ToolLoopConfig,
  step_index: number,
  step_span: string | undefined,
): Promise<TurnResult> {
  try {
    const request_messages = await apply_prepare_step(config, step_index)
    config.trajectory?.record({ kind: 'request_sent', step_index })
    const turn = await config.invoke_once({
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
    return turn
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    end_step_span(config.trajectory, step_span, { error: message })
    throw err
  }
}

/**
 * Salvage text-embedded tool calls from an eligible turn.
 *
 * A turn that "stopped" with plain text may hold a call the runtime failed
 * to parse into tool_calls; salvage before deciding the step ends the loop.
 * History gets the stripped text + structured parts (raw markup in history
 * would teach the model the text format works, and a tool result without a
 * matching call part is rejected by OpenAI-compatible APIs);
 * StepRecord.text keeps the raw text for debugging. Returns the native view
 * unchanged when the turn is ineligible or nothing salvages.
 */
async function salvage_turn(
  config: ToolLoopConfig,
  turn: TurnResult,
  tool_map: ReadonlyMap<string, Tool>,
  step_index: number,
): Promise<SalvageView> {
  const native: SalvageView = {
    calls: turn.tool_calls,
    history_text: turn.text,
    formats: new Map(),
    outcome: undefined,
  }
  const budget = config.salvage_budget
  const eligible =
    turn.tool_calls.length === 0 &&
    (turn.finish_reason === 'stop' || turn.finish_reason === 'length') &&
    config.tools.length > 0 &&
    budget !== undefined &&
    budget.remaining > 0
  if (!eligible) return native

  const outcome = await salvage_tool_calls(turn.text, tool_map)
  if (outcome === undefined) return native
  budget.remaining -= 1
  const formats = new Map<string, SalvageFormat>()
  const calls = outcome.calls.map((c, n) => {
    const id = `salvaged_${step_index}_${n}`
    formats.set(id, c.format)
    return { id, name: c.name, input: c.input }
  })
  record_tool_call_salvaged(config.trajectory, {
    step_index,
    calls: calls.map((c) => ({
      tool_call_id: c.id,
      name: c.name,
      // Stryker disable next-line StringLiteral: formats has an entry for every id (set just above), so the ?? 'json' fallback is unreachable.
      format: formats.get(c.id) ?? 'json',
    })),
    raw_text: turn.text,
  })
  await dispatch_salvaged_call_chunks(config, calls, step_index)
  return { calls, history_text: outcome.stripped_text, formats, outcome }
}

/**
 * Mirror the native stream for salvaged calls, which emits start/end for
 * every call the model attempted, including ones the per-step clamp later
 * drops.
 */
async function dispatch_salvaged_call_chunks(
  config: ToolLoopConfig,
  calls: ReadonlyArray<RawToolCall>,
  step_index: number,
): Promise<void> {
  if (config.dispatch_chunk === undefined) return
  for (const c of calls) {
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

/**
 * Apply `max_tool_calls_per_step` to a turn's calls, native and salvaged
 * alike. Dropped calls never reach history; the model re-issues them on a
 * later turn if it still wants them.
 */
function clamp_calls(
  config: ToolLoopConfig,
  calls: ReadonlyArray<RawToolCall>,
  step_index: number,
): { kept: ReadonlyArray<RawToolCall>; dropped: ReadonlyArray<RawToolCall> } {
  const cap = config.max_tool_calls_per_step
  if (cap === undefined || calls.length <= cap) return { kept: calls, dropped: [] }
  const kept = calls.slice(0, cap)
  const dropped = calls.slice(cap)
  record_tool_calls_dropped(config.trajectory, {
    step_index,
    max_tool_calls_per_step: cap,
    kept: kept.length,
    dropped: dropped.map((d) => ({ tool_call_id: d.id, name: d.name })),
  })
  return { kept, dropped }
}

/**
 * Record a call that resolved to an error on the feed-back path: the error
 * record, the fed-back error tool_result message, the tool_call trajectory
 * event, and the stream chunk, in that order. Throw-policy paths raise
 * before reaching here.
 */
async function record_failed_call(
  ctx: StepContext,
  call: { id: string; name: string; input: unknown },
  message: string,
  timing: { duration_ms: number; started_at: number },
): Promise<void> {
  const record: ToolCallRecord = {
    id: call.id,
    name: call.name,
    input: call.input,
    error: { message },
    duration_ms: timing.duration_ms,
    started_at: timing.started_at,
  }
  ctx.records.push(record)
  ctx.all_records.push(record)
  ctx.feed.push(
    build_tool_result_message(call.id, call.name, { error: message }),
  )
  record_tool_call(ctx.config.trajectory, {
    step_index: ctx.step_index,
    name: call.name,
    tool_call_id: call.id,
    input: call.input,
    duration_ms: timing.duration_ms,
    error: { message },
  })
  await dispatch_tool_result_chunk(
    ctx.config.dispatch_chunk,
    ctx.step_index,
    call.id,
    undefined,
    { message },
  )
}

/**
 * Record a call that never reached execution (the final-turn max_steps skip,
 * the per-step-cap drop): an error record and a tool_result stream chunk,
 * but no tool_call trajectory event, no execution, and no fed-back tool
 * message.
 */
async function record_unexecuted_call(
  ctx: StepContext,
  call: RawToolCall,
  message: string,
): Promise<void> {
  const record: ToolCallRecord = {
    id: call.id,
    name: call.name,
    input: call.input,
    error: { message },
    duration_ms: 0,
    started_at: Date.now(),
  }
  ctx.records.push(record)
  ctx.all_records.push(record)
  await dispatch_tool_result_chunk(
    ctx.config.dispatch_chunk,
    ctx.step_index,
    call.id,
    undefined,
    { message },
  )
}

/**
 * Look up the named tool and validate the raw input against its schema.
 * Returns undefined when the failure was recorded on the feed-back path;
 * throws under 'throw' policy for an unknown tool.
 */
async function resolve_tool_and_input(
  ctx: StepContext,
  raw_call: RawToolCall,
): Promise<{ tool: Tool; input: unknown } | undefined> {
  const tool = ctx.tool_map.get(raw_call.name)
  if (tool === undefined) {
    const err_message = `unknown tool '${raw_call.name}'`
    if (ctx.config.tool_error_policy === 'throw') {
      const thrown = new tool_error(err_message, {
        tool_name: raw_call.name,
        tool_call_id: raw_call.id,
        cause: new Error(err_message),
      })
      end_step_span(ctx.config.trajectory, ctx.step_span, { error: err_message })
      throw thrown
    }
    await record_failed_call(ctx, raw_call, err_message, {
      duration_ms: 0,
      started_at: Date.now(),
    })
    return undefined
  }

  const validation = await validate_tool_input(tool, raw_call.input)
  if (!validation.ok) {
    await record_failed_call(ctx, raw_call, validation.message, {
      duration_ms: 0,
      started_at: Date.now(),
    })
    return undefined
  }

  return { tool, input: validation.value }
}

/**
 * Resolve whether the call may execute (see request_approval). A denial
 * either throws ('throw' policy) or records the denied call and returns
 * false; an abort or handler rejection closes the step span and rethrows.
 */
async function approve_call(
  ctx: StepContext,
  tool: Tool,
  input: unknown,
  raw_call: RawToolCall,
): Promise<boolean> {
  let approved: boolean
  try {
    approved = await request_approval(
      tool,
      input,
      ctx.step_index,
      raw_call.id,
      ctx.config.abort,
      ctx.config.on_tool_approval,
      ctx.config.trajectory,
    )
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    end_step_span(ctx.config.trajectory, ctx.step_span, { error: message })
    throw err
  }
  if (approved) return true

  const denied_message = 'tool_approval_denied'
  if (ctx.config.tool_error_policy === 'throw') {
    const thrown = new tool_approval_denied_error(
      `tool '${tool.name}' approval denied`,
      { tool_name: tool.name, step_index: ctx.step_index, tool_call_id: raw_call.id },
    )
    end_step_span(ctx.config.trajectory, ctx.step_span, { error: denied_message })
    throw thrown
  }
  await record_failed_call(
    ctx,
    { id: raw_call.id, name: tool.name, input },
    denied_message,
    { duration_ms: 0, started_at: Date.now() },
  )
  return false
}

/**
 * Execute an approved call and record the outcome: a success record with
 * output (flipping terminal_fired for an ends_turn tool), or the error path
 * via record_execute_failure.
 */
async function execute_approved_call(
  ctx: StepContext,
  tool: Tool,
  input: unknown,
  raw_call: RawToolCall,
): Promise<void> {
  const started_at = Date.now()
  const tool_ctx: ToolExecContext = {
    abort: ctx.config.abort,
    tool_call_id: raw_call.id,
    step_index: ctx.step_index,
    ...(ctx.config.trajectory !== undefined ? { trajectory: ctx.config.trajectory } : {}),
  }

  let output: unknown
  let err_message: string | undefined
  let thrown: unknown
  try {
    const execute = tool.execute
    const maybe = execute(input, tool_ctx)
    output = maybe instanceof Promise ? await maybe : maybe
  } catch (err: unknown) {
    thrown = err
    err_message = serialize_error(err)
  }

  const duration_ms = Date.now() - started_at

  if (thrown !== undefined) {
    await record_execute_failure(ctx, tool, raw_call, input, {
      thrown,
      err_message,
      duration_ms,
      started_at,
    })
    return
  }

  const record: ToolCallRecord = {
    id: raw_call.id,
    name: tool.name,
    input,
    output,
    duration_ms,
    started_at,
  }
  ctx.records.push(record)
  ctx.all_records.push(record)
  if (tool.ends_turn === true) ctx.terminal_fired = true
  ctx.feed.push(build_tool_result_message(raw_call.id, tool.name, output ?? ''))
  record_tool_call(ctx.config.trajectory, {
    step_index: ctx.step_index,
    name: tool.name,
    tool_call_id: raw_call.id,
    input,
    duration_ms,
  })
  await dispatch_tool_result_chunk(ctx.config.dispatch_chunk, ctx.step_index, raw_call.id, output)
}

/**
 * Handle a throwing execute: an abort in flight or 'throw' policy closes
 * the step span and throws; feed-back policy records the failure with the
 * measured timing.
 */
async function record_execute_failure(
  ctx: StepContext,
  tool: Tool,
  raw_call: RawToolCall,
  input: unknown,
  failure: {
    thrown: unknown
    err_message: string | undefined
    duration_ms: number
    started_at: number
  },
): Promise<void> {
  if (ctx.config.abort.aborted) {
    const abort_err = new aborted_error('aborted', {
      reason: ctx.config.abort.reason,
      step_index: ctx.step_index,
      tool_call_in_flight: { id: raw_call.id, name: tool.name },
    })
    end_step_span(ctx.config.trajectory, ctx.step_span, { error: 'aborted' })
    throw abort_err
  }
  if (ctx.config.tool_error_policy === 'throw') {
    const wrapped = new tool_error(
      `tool '${tool.name}' failed: ${failure.err_message ?? 'unknown'}`,
      {
        tool_name: tool.name,
        tool_call_id: raw_call.id,
        cause: failure.thrown,
      },
    )
    end_step_span(ctx.config.trajectory, ctx.step_span, {
      // Stryker disable next-line StringLiteral: err_message is always a string in this branch (set from serialize_error in the catch), so the ?? 'tool error' fallback is unreachable.
      error: failure.err_message ?? 'tool error',
    })
    throw wrapped
  }
  await record_failed_call(
    ctx,
    { id: raw_call.id, name: tool.name, input },
    // Stryker disable next-line StringLiteral: err_message is always a string here (see catch above), so this ?? 'unknown' fallback is unreachable.
    failure.err_message ?? 'unknown',
    { duration_ms: failure.duration_ms, started_at: failure.started_at },
  )
}

/**
 * Run one raw tool call through the guard chain — final-turn skip, tool
 * lookup, input validation, approval — then execute it. Each guard either
 * records the failure (feed-back policy) and stops, or throws (throw
 * policy / abort).
 */
async function process_call(ctx: StepContext, raw_call: RawToolCall): Promise<void> {
  throw_if_aborted_in_flight(ctx.config.abort, ctx.step_index, {
    id: raw_call.id,
    name: raw_call.name,
  })

  // A successful terminal call needs no follow-up turn, so it is exempt
  // from this skip: it executes below and ends the loop cleanly, winning
  // over the coincident max_steps cap.
  if (ctx.would_exceed_after && ctx.tool_map.get(raw_call.name)?.ends_turn !== true) {
    await record_unexecuted_call(ctx, raw_call, 'max_steps_exceeded_before_execution')
    return
  }

  const resolved = await resolve_tool_and_input(ctx, raw_call)
  if (resolved === undefined) return

  const approved = await approve_call(ctx, resolved.tool, resolved.input, raw_call)
  if (!approved) return

  throw_if_aborted_in_flight(ctx.config.abort, ctx.step_index, {
    id: raw_call.id,
    name: resolved.tool.name,
  })

  await execute_approved_call(ctx, resolved.tool, resolved.input, raw_call)
}

/**
 * Stamp salvage provenance onto the records of calls that came from text
 * salvage rather than structured output.
 */
function mark_salvaged(
  records: ReadonlyArray<ToolCallRecord>,
  formats: ReadonlyMap<string, SalvageFormat>,
): void {
  for (const r of records) {
    const format = formats.get(r.id)
    if (format !== undefined) {
      r.salvaged = true
      r.salvaged_format = format
    }
  }
}

/**
 * Emit a tool_result for every resolved call in this step (success carries
 * output, feed-back failures carry error). Throw-policy and aborted calls
 * exit before here and surface loudly as a thrown error instead.
 */
function emit_tool_results(
  config: ToolLoopConfig,
  step_index: number,
  records: ReadonlyArray<ToolCallRecord>,
): void {
  for (const r of records) {
    record_tool_result(config.trajectory, {
      step_index,
      name: r.name,
      tool_call_id: r.id,
      duration_ms: r.duration_ms,
      ...(r.error !== undefined ? { error: r.error } : { output: r.output }),
    })
  }
}

/**
 * The finish reason a tool-call step reports. A salvaged step reports
 * 'tool_calls': downstream consumers see the same shape a native tool turn
 * produces; the salvaged flags carry provenance. A terminal step reports
 * 'tool_calls' (it genuinely made calls); the loop-level finish_reason
 * 'stop' is the separate signal that generation ended.
 */
function resolve_turn_finish_reason(
  ctx: StepContext,
  salvaged: boolean,
  turn_finish: FinishReason,
): FinishReason {
  if (ctx.terminal_fired) return 'tool_calls'
  if (ctx.would_exceed_after) return 'max_steps'
  if (salvaged) return 'tool_calls'
  return turn_finish
}

/**
 * Build one StepRecord — cost derived and recorded, provider_reported
 * passed through — push it, notify on_finish_step, and close the step span.
 */
function push_step_record(
  config: ToolLoopConfig,
  acc: LoopAccumulator,
  step_index: number,
  turn: TurnResult,
  tool_calls: ToolCallRecord[],
  finish_reason: FinishReason,
  step_span: string | undefined,
): void {
  const record: StepRecord = {
    index: step_index,
    text: turn.text,
    tool_calls,
    usage: turn.usage,
    finish_reason,
  }
  const breakdown = compute_and_record_cost(config, step_index, turn.usage)
  if (breakdown !== undefined) record.cost = breakdown
  if (turn.provider_reported !== undefined) {
    record.provider_reported = turn.provider_reported
  }
  acc.steps.push(record)
  if (config.on_finish_step !== undefined) config.on_finish_step(record)
  end_step_span(config.trajectory, step_span, {
    usage: turn.usage,
    finish_reason,
  })
}

/**
 * Run one loop iteration: invoke the turn, salvage and clamp its calls,
 * execute them sequentially, and record the step. Returns the finished
 * ToolLoopResult when this step ends the loop (no calls, terminal tool,
 * max_steps), undefined when the loop should continue.
 */
async function run_loop_step(
  config: ToolLoopConfig,
  tool_map: ReadonlyMap<string, Tool>,
  acc: LoopAccumulator,
  step_index: number,
): Promise<ToolLoopResult | undefined> {
  const step_span = start_step_span(config.trajectory, step_index)
  const turn = await invoke_turn(config, step_index, step_span)

  const view = await salvage_turn(config, turn, tool_map, step_index)
  const { kept, dropped } = clamp_calls(config, view.calls, step_index)
  config.messages.push(build_assistant_message(view.history_text, kept))

  if (kept.length === 0) {
    push_step_record(config, acc, step_index, turn, [], turn.finish_reason, step_span)
    return loop_result(acc, turn.text, turn.finish_reason, false)
  }

  // This turn has tool calls. Execute them sequentially.
  const ctx: StepContext = {
    config,
    tool_map,
    step_index,
    step_span,
    would_exceed_after: step_index + 1 >= config.max_steps,
    records: [],
    all_records: acc.tool_calls,
    feed: [],
    terminal_fired: false,
  }
  for (const raw_call of kept) await process_call(ctx, raw_call)

  // Dropped calls mirror the max_steps precedent: a record with an error
  // and a tool_result event/chunk, but no tool_call event, no execution,
  // and no fed-back tool message (their call parts are not in history).
  for (const d of dropped) {
    await record_unexecuted_call(ctx, d, 'dropped_max_tool_calls_per_step')
  }

  mark_salvaged(ctx.records, view.formats)
  emit_tool_results(config, step_index, ctx.records)
  for (const m of ctx.feed) config.messages.push(m)

  const turn_finish_reason = resolve_turn_finish_reason(
    ctx,
    view.outcome !== undefined,
    turn.finish_reason,
  )
  push_step_record(config, acc, step_index, turn, ctx.records, turn_finish_reason, step_span)

  // A successful terminal call ends the loop cleanly. Placed before the
  // max_steps break so a terminal finish wins over a coincident cap: the
  // full step is already recorded, so the result stays complete.
  if (ctx.terminal_fired) return loop_result(acc, turn.text, 'stop', false)
  if (ctx.would_exceed_after) return loop_result(acc, turn.text, 'max_steps', true)
  return undefined
}

/**
 * Run the model-turn / tool-execution loop to completion.
 *
 * Each iteration invokes the transport seam once, salvages text-embedded
 * tool calls when eligible, clamps to `max_tool_calls_per_step`, executes
 * calls sequentially under the header invariants, and feeds results back
 * until the model stops, a terminal tool fires, or `max_steps` is reached.
 */
export async function run_tool_loop(config: ToolLoopConfig): Promise<ToolLoopResult> {
  const acc: LoopAccumulator = { steps: [], tool_calls: [] }
  const tool_map = new Map<string, Tool>()
  for (const t of config.tools) tool_map.set(t.name, t)

  let step_index = config.step_index_start
  while (true) {
    throw_if_aborted(config.abort, step_index)
    if (step_index >= config.max_steps) return loop_result(acc, '', 'max_steps', true)
    const finished = await run_loop_step(config, tool_map, acc, step_index)
    if (finished !== undefined) return finished
    step_index += 1
  }
}
