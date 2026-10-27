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
 *   - max_tool_calls_per_step: a call to a tool flagged read_only doesn't
 *     count toward the cap. The first counted call past it, and every call
 *     after that one, are dropped for the step, so what runs is a prefix of
 *     what the model asked for. Dropped calls are recorded with
 *     error: { message: 'dropped_max_tool_calls_per_step' } and excluded from
 *     the assistant history message, so providers that require a result per
 *     emitted call do not reject the next request. When the loop goes on,
 *     one user message after the step's tool results names them, so the
 *     model learns they didn't run and can make them again.
 *   - ends_turn (Tool.ends_turn): a tool flagged terminal ends the loop when a
 *     call to it executes SUCCESSFULLY. The call runs the normal execute path
 *     (record, fed tool_result message, trajectory events + chunk), then the
 *     loop breaks with finish_reason 'stop' instead of running another model
 *     turn. Salvaged terminal calls behave identically. A denied, invalid,
 *     dropped, or throwing terminal call does NOT end the loop. A successful
 *     terminal call is exempt from the max_steps would_exceed_after skip (it
 *     needs no follow-up turn), so a terminal finish wins over a coincident
 *     max_steps cap (finish_reason 'stop', max_steps_reached false).
 *   - truncated_turns (truncated_turn_policy 'continue'): a turn that
 *     finishes 'length' with no calls, salvaged ones included, on a call
 *     with tools and with a step left, doesn't end the loop. Its visible
 *     text goes back as a plain assistant message (none when it showed no
 *     text, and never its reasoning), then a user message that says it was
 *     cut off. The turn counts toward max_steps, records turn_truncated, and
 *     its StepRecord says truncated: true. Without the holder, or on the last
 *     step, such a turn ends the loop with 'length' as before.
 *
 * The loop does not itself call the AI SDK. It invokes a supplied `invoke_once`
 * seam that returns a neutral TurnResult. generate.ts builds the real seam
 * (the ai_sdk transport in providers/ai_sdk/, or a native adapter's
 * invoke_turn); tests inject a mock seam directly.
 */

import { format_schema_issues, is_record, to_json_schema, validate_schema, type ToolSchema } from '#schema'
import type { TrajectoryLogger } from '#core'
import type {
  AssistantContentPart,
  CaptureLevel,
  CapturePayload,
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
  TurnRequest,
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
  record_cache_miss,
  record_capture_redaction_failed,
  record_cost,
  record_request_sent,
  record_request_wire,
  record_response_received,
  record_tool_approval,
  record_tool_call,
  record_tool_call_salvaged,
  record_tool_calls_dropped,
  record_tool_result,
  record_turn_paused,
  record_turn_truncated,
  end_step_span,
  start_step_span,
  type PricingMissingDedup,
} from './trajectory.js'
import { compute_cost, decompose_total_cost, FREE_PROVIDERS } from './pricing.js'

export type InvokeOnceArgs = {
  readonly step_index: number
  readonly messages: ReadonlyArray<Message>
  readonly tools: ReadonlyArray<Tool>
  readonly abort: AbortSignal
  readonly stream: boolean
  /**
   * The enclosing `engine.generate.step` span id, threaded so the transport's
   * retry wrapper can stamp it onto `turn_retry` (the one span-less engine
   * event emitted below the loop, inside retry_turn).
   */
  readonly step_span: string | undefined
  /**
   * Present when the call captures at `'wire'`: the native transport hands
   * it to the adapter as `TurnRequest.on_wire`, and the ai_sdk transport,
   * whose SDK builds the body, never calls it.
   */
  readonly on_wire?: TurnRequest['on_wire']
}

export type RawToolCall = {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

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
  /**
   * Present only under `truncated_turn_policy: 'continue'`, when the loop
   * goes on past a turn that hit its output limit before it made a call (see
   * continue_truncated_turn). `max_tokens` is the call's limit, when it set
   * one, which the notice names. undefined ends the loop on such a turn.
   */
  readonly truncated_turns?: { readonly max_tokens: number | undefined } | undefined
  /**
   * What the loop remembers from one turn to the next across a whole
   * generate call, schema-repair re-invocations included, held the way
   * salvage_budget is. Absent, each run_tool_loop starts its own.
   */
  readonly call_memory?: CallMemory
  /**
   * What the loop records of each turn's request and reply. Its
   * `call_span_id` rides every request_sent; absent, the loop records no
   * request and no reply, and request_sent names no call span.
   */
  readonly capture?: LoopCapture
}

/**
 * The state a generate call's turns share: the previous turn's cache reads
 * plus writes, which tells a cache miss from a turn that never cached, and
 * the JSON text of each message the last captured request held, which tells
 * a turn that extends it from one that doesn't. `captured_messages` is
 * undefined before the first captured turn and after a payload that was
 * dropped.
 */
export type CallMemory = {
  previous_cache_traffic: number
  captured_messages?: ReadonlyArray<string> | undefined
}

/**
 * How a generate call captures its turns: the level, the `engine.generate`
 * span every request_sent names, the call's settings as its first turn
 * records them, built only when a turn asks for them, and the engine's
 * redactor, which every payload passes through on its way to the trajectory.
 */
export type LoopCapture = {
  readonly level: CaptureLevel
  readonly call_span_id: string | undefined
  readonly settings: () => Readonly<Record<string, unknown>>
  readonly redact?: ((payload: CapturePayload) => unknown) | undefined
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
      `tool approval required for '${tool.name}': pass an on_tool_approval handler to generate(), or clear needs_approval on the tool`,
      { tool_name: tool.name, step_index, tool_call_id },
    )
  }

  const approval_promise = Promise.resolve(
    on_tool_approval({ tool_name: tool.name, input, step_index, tool_call_id, abort }),
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
 * model, JSON-serializing non-string content. A failed call's message carries
 * `is_error: true`; a success's carries no such key.
 */
function build_tool_result_message(
  tool_call_id: string,
  tool_name: string,
  content: unknown,
  is_error = false,
): Message {
  const serialized =
    typeof content === 'string' ? content : safe_json_stringify(content)
  return {
    role: 'tool',
    tool_call_id,
    name: tool_name,
    content: serialized,
    ...(is_error ? { is_error: true } : {}),
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
 * Build the assistant history message for a turn. A turn with `content`
 * keeps the provider's parts in its order, data included, so reasoning goes
 * back beside the text and calls it came with. Any other turn is plain text
 * when there are no tool calls, otherwise text plus tool_call parts.
 */
function build_assistant_message(
  turn: TurnResult,
  view: SalvageView,
  kept: ReadonlyArray<RawToolCall>,
): Message {
  if (turn.content !== undefined) {
    return { role: 'assistant', content: history_parts(turn.content, view, kept) }
  }
  if (kept.length === 0) return { role: 'assistant', content: view.history_text }
  const parts: AssistantContentPart[] = []
  if (view.history_text.length > 0) parts.push({ type: 'text', text: view.history_text })
  for (const tc of kept) parts.push(tool_call_part(tc))
  return { role: 'assistant', content: parts }
}

/**
 * A raw call as a history part, carrying no provider data.
 */
function tool_call_part(tc: RawToolCall): AssistantContentPart {
  return { type: 'tool_call', id: tc.id, name: tc.name, input: tc.input }
}

/**
 * A turn's own parts for history. A call the per-step clamp dropped leaves,
 * as it leaves the plain message, while everything around it stays.
 */
function history_parts(
  content: ReadonlyArray<AssistantContentPart>,
  view: SalvageView,
  kept: ReadonlyArray<RawToolCall>,
): AssistantContentPart[] {
  if (view.outcome !== undefined) return salvaged_parts(content, view.history_text, kept)
  const kept_ids = new Set(kept.map((tc) => tc.id))
  return content.filter((part) => part.type !== 'tool_call' || kept_ids.has(part.id))
}

/**
 * A salvaged turn's parts for history: the stripped text replaces the text
 * parts at the first one's place, and the salvaged calls follow the last
 * part. Salvage runs only on a turn with no native calls, so the provider
 * gave its calls no place of their own. The replacement carries no provider
 * data, since whatever the provider attached belonged to the text salvage
 * rewrote.
 */
function salvaged_parts(
  content: ReadonlyArray<AssistantContentPart>,
  stripped_text: string,
  kept: ReadonlyArray<RawToolCall>,
): AssistantContentPart[] {
  const parts: AssistantContentPart[] = []
  let text_placed = false
  for (const part of content) {
    if (part.type !== 'text') {
      parts.push(part)
    } else if (!text_placed) {
      text_placed = true
      if (stripped_text.length > 0) parts.push({ type: 'text', text: stripped_text })
    }
  }
  for (const tc of kept) parts.push(tool_call_part(tc))
  return parts
}

/**
 * Derive the step's cost and record it.
 *
 * A cost the provider reported wins over any pricing row, since it is what
 * was charged: it is split by token weight and recorded as
 * `provider_reported`, and the pricing lookup never runs, so no
 * `pricing_missing` either. Otherwise the cost comes from the pricing tables,
 * where missing pricing for a paid provider emits `pricing_missing` (deduped
 * per call) and yields no breakdown; free providers skip the emit entirely.
 */
function compute_and_record_cost(
  config: ToolLoopConfig,
  step_index: number,
  turn: TurnResult,
  step_span: string | undefined,
): CostBreakdown | undefined {
  if (turn.reported_cost_usd !== undefined) {
    const reported = decompose_total_cost(turn.reported_cost_usd, turn.usage)
    record_cost(config.trajectory, step_index, reported, 'provider_reported', step_span)
    return reported
  }
  const pricing = config.resolve_pricing()
  if (pricing === undefined && !FREE_PROVIDERS.has(config.provider)) {
    config.pricing_dedup.emit(config.provider, config.model_id)
    return undefined
  }
  const breakdown = compute_cost(turn.usage, pricing, config.provider)
  if (breakdown !== undefined) {
    record_cost(config.trajectory, step_index, breakdown, 'engine_derived', step_span)
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
 * transcript. A step_prepared event makes the mid-loop mutation legible
 * with the before/after message counts.
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
  /**
   * The texts of the paused turns since the last tool turn, which the call's
   * text joins with the final turn's, as one response's text blocks join.
   */
  readonly paused_texts: string[]
  /** The call's memory across turns: config.call_memory, or this run's own. */
  readonly memory: CallMemory
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
 * The text is the final turn's, after the texts of any paused turns that it
 * continued.
 */
function loop_result(
  acc: LoopAccumulator,
  text: string,
  finish_reason: FinishReason,
  max_steps_reached: boolean,
): ToolLoopResult {
  return {
    text: [...acc.paused_texts, text].join(''),
    steps: acc.steps,
    tool_calls: acc.tool_calls,
    finish_reason,
    max_steps_reached,
  }
}

/**
 * Continue a turn the provider paused without calls: send its assistant
 * message back as it is, with nothing after it, which is how a paused
 * response resumes, and ask for another turn, which counts toward
 * `max_steps`. A pause on the last allowed step ends the loop with
 * `'max_steps'` and the paused turn's text. Salvage and the clamp never see a
 * paused turn.
 */
function continue_paused_turn(
  config: ToolLoopConfig,
  acc: LoopAccumulator,
  step_index: number,
  step_span: string | undefined,
  turn: TurnResult,
): ToolLoopResult | undefined {
  const view: SalvageView = { calls: [], history_text: turn.text, formats: new Map(), outcome: undefined }
  config.messages.push(build_assistant_message(turn, view, []))
  const at_cap = step_index + 1 >= config.max_steps
  push_step_record(config, acc, step_index, turn, [], at_cap ? 'max_steps' : turn.finish_reason, step_span)
  if (at_cap) return loop_result(acc, turn.text, 'max_steps', true)
  acc.paused_texts.push(turn.text)
  return undefined
}

/**
 * The truncated-turn holder when the loop goes on past this turn, which made
 * no call, salvaged ones included, and undefined when the turn ends the loop
 * as any other turn without calls does. The loop goes on only past a turn
 * that hit its output limit, on a call that asked it to and has tools, so the
 * turn could have made one, and with a step left for another turn.
 */
function truncation_holder(
  config: ToolLoopConfig,
  turn: TurnResult,
  step_index: number,
): { readonly max_tokens: number | undefined } | undefined {
  const goes_on =
    turn.finish_reason === 'length' && config.tools.length > 0 && step_index + 1 < config.max_steps
  return goes_on ? config.truncated_turns : undefined
}

/**
 * The user message that follows a turn the loop went on past. It says that
 * the turn was cut off, naming the limit when the call set `max_tokens`, and
 * asks for a shorter one: the next tool call or the final answer, since a
 * turn can be cut off partway through an answer as well as its reasoning.
 */
function truncation_notice(max_tokens: number | undefined): Message {
  const limit = max_tokens === undefined ? 'the output limit' : `the ${String(max_tokens)}-token output limit`
  return {
    role: 'user',
    content:
      `Your last turn reached ${limit} before it finished, so it was cut off. ` +
      'Keep this turn short: make your next tool call, or give your final answer.',
  }
}

/**
 * Go on past a turn that hit its output limit before it made a call. Its
 * visible text goes back as a plain assistant message, and nothing goes back
 * when it showed only whitespace, which some transports would send as an
 * empty block that the API refuses. Its reasoning never goes back: a thinking
 * block cut off before its signature can't be sent again, and the abandoned
 * reasoning is what the limit was set to stop paying for. The notice follows
 * it. The turn counts toward max_steps, its record says truncated, and it
 * ends whatever response the paused turns before it began.
 */
function continue_truncated_turn(
  config: ToolLoopConfig,
  acc: LoopAccumulator,
  at: { readonly step_index: number; readonly step_span: string | undefined },
  turn: TurnResult,
  max_tokens: number | undefined,
): void {
  record_turn_truncated(config.trajectory, {
    step_index: at.step_index,
    span_id: at.step_span,
    output_tokens: turn.usage.output_tokens,
    max_tokens,
  })
  if (turn.text.trim().length > 0) config.messages.push({ role: 'assistant', content: turn.text })
  config.messages.push(truncation_notice(max_tokens))
  push_step_record(config, acc, at.step_index, turn, [], 'length', at.step_span, true)
  acc.paused_texts.length = 0
}

/**
 * Record a `cache_miss` when the previous turn read or wrote cache tokens
 * and this one read none, then remember this turn's reads plus writes for
 * the next. The rule needs no table of model minimums and no knowledge of
 * the provider.
 */
function note_cache_traffic(
  config: ToolLoopConfig,
  memory: CallMemory,
  usage: UsageTotals,
  turn: { readonly step_index: number; readonly span_id: string | undefined; readonly after_prepare_step: boolean },
): void {
  const reads = usage.cached_input_tokens ?? 0
  if (memory.previous_cache_traffic > 0 && reads === 0) {
    record_cache_miss(config.trajectory, {
      ...turn,
      previous_cached_tokens: memory.previous_cache_traffic,
      input_tokens: usage.input_tokens,
    })
  }
  memory.previous_cache_traffic = reads + (usage.cache_write_tokens ?? 0)
}

/**
 * The call's capture when it records its turns' requests and replies, and
 * undefined when it records neither.
 */
function active_capture(config: ToolLoopConfig): LoopCapture | undefined {
  const capture = config.capture
  return capture !== undefined && capture.level !== 'off' ? capture : undefined
}

/**
 * JSON.stringify's replacer for a captured value: a `Uint8Array`, a Node
 * `Buffer` included, becomes its base64 text, read off the holder because a
 * Buffer's own toJSON has already run by the time the replacer sees it.
 */
function capture_replacer(this: Readonly<Record<string, unknown>>, key: string, value: unknown): unknown {
  const raw = this[key]
  return raw instanceof Uint8Array ? Buffer.from(raw).toString('base64') : value
}

/**
 * The JSON text a captured value is recorded as. Throws on a value that JSON
 * can't hold, a BigInt or a cycle.
 */
function capture_text(value: unknown): string {
  return JSON.stringify(value, capture_replacer)
}

/**
 * A fresh, JSON-safe copy of a value, as capture records it.
 */
function capture_copy(value: unknown): unknown {
  return JSON.parse(capture_text(value))
}

/**
 * A schema as JSON Schema with `to_json_schema`'s defaults, or undefined when
 * it can't be written as one.
 */
export function json_schema_or_undefined(schema: ToolSchema): Record<string, unknown> | undefined {
  let json: Record<string, unknown> | undefined
  try {
    json = to_json_schema(schema)
  } catch {
    // A schema that can't be written as JSON Schema stays undefined.
  }
  return json
}

/**
 * A tool as capture records it: its name, its description, and its input
 * schema as JSON Schema. A schema that can't be written as one stays
 * undefined, which the JSON copy leaves out.
 */
function captured_tool(tool: Tool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: json_schema_or_undefined(tool.input_schema),
  }
}

/**
 * A later turn's request: the messages it appended when it starts with
 * every message the previous captured turn held, and its whole array marked
 * `reshaped` otherwise, or when the previous turn's payload was dropped.
 */
function later_request(
  previous: ReadonlyArray<string> | undefined,
  texts: ReadonlyArray<string>,
  copies: ReadonlyArray<unknown>,
): Record<string, unknown> {
  if (previous?.every((text, n) => texts[n] === text) === true) {
    return { appended: copies.slice(previous.length) }
  }
  return { messages: copies, reshaped: true }
}

/**
 * The `request` a turn's request_sent carries under capture, built from
 * fresh JSON-safe copies of what the turn sends, so the loop's later pushes
 * never reach it. A call's first turn records its settings, its tools, and
 * every message; a later one records what changed (see later_request). The
 * messages' JSON text is remembered for the next turn. A value JSON can't
 * hold drops the payload, and the call goes on.
 */
function capture_request(
  config: ToolLoopConfig,
  capture: LoopCapture,
  memory: CallMemory,
  step_index: number,
  messages: ReadonlyArray<Message>,
): Record<string, unknown> | undefined {
  const previous = memory.captured_messages
  memory.captured_messages = undefined
  let request: Record<string, unknown> | undefined
  try {
    const texts = messages.map(capture_text)
    const copies = texts.map((text): unknown => JSON.parse(text))
    request =
      step_index === 0
        ? {
            settings: capture_copy(capture.settings()),
            tools: capture_copy(config.tools.map(captured_tool)),
            messages: copies,
          }
        : later_request(previous, texts, copies)
    memory.captured_messages = texts
  } catch {
    // A value that JSON can't hold drops the payload, and the call goes on.
  }
  return request
}

/**
 * The parts a turn returned, as response_received records them under
 * capture: the turn's own parts when its adapter set them, and otherwise its
 * text, when it has any, followed by its calls. A value JSON can't hold
 * drops them.
 */
function capture_response(turn: TurnResult): unknown {
  const parts = turn.content ?? [
    ...(turn.text.length > 0 ? [{ type: 'text', text: turn.text }] : []),
    ...turn.tool_calls.map(tool_call_part),
  ]
  let content: unknown
  try {
    content = capture_copy(parts)
  } catch {
    // A value that JSON can't hold drops the parts, and the call goes on.
  }
  return content
}

const REDACTION_FAILED: unique symbol = Symbol('redaction_failed')

/**
 * True for a promise, or any other object with a `then` method.
 */
function is_thenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'then') === 'function'
}

/**
 * Hand a payload to the redactor, and return what it returned, or
 * REDACTION_FAILED when it threw or returned a thenable. The engine records
 * synchronously, so it can't wait for a thenable, and a rejection it leaves
 * behind is swallowed rather than left unhandled.
 */
function apply_redactor(redact: (payload: CapturePayload) => unknown, payload: CapturePayload): unknown {
  try {
    const recorded = redact(payload)
    if (!is_thenable(recorded)) return recorded
    Promise.resolve(recorded).catch(() => undefined)
  } catch {
    // A redactor that throws fails closed, below.
  }
  return REDACTION_FAILED
}

/**
 * What the trajectory records for a captured payload: the payload itself,
 * or what the engine's redactor returned in its place, `undefined` recording
 * nothing. A payload that couldn't be built (`data` undefined), and a
 * redactor that failed, record nothing and say so with
 * `capture_redaction_failed`, so nothing the redactor would have scrubbed is
 * written.
 */
function redact_payload(
  config: ToolLoopConfig,
  capture: LoopCapture,
  payload: CapturePayload,
  span_id: string | undefined,
): unknown {
  const recorded =
    payload.data === undefined
      ? REDACTION_FAILED
      : capture.redact === undefined
        ? payload.data
        : apply_redactor(capture.redact, payload)
  if (recorded !== REDACTION_FAILED) return recorded
  record_capture_redaction_failed(config.trajectory, { step_index: payload.step_index, span_id, payload_kind: payload.kind })
  return undefined
}

/**
 * Record the exact body a native adapter is about to send, from a fresh copy
 * of `{ url, body }` that goes through the redactor, so nothing the redactor
 * does reaches the wire. The event carries the `url` and `body` of the object
 * the redactor returns, leaving out either one it dropped. A redactor that
 * returns anything other than an object fails closed.
 */
function record_wire(
  config: ToolLoopConfig,
  capture: LoopCapture,
  turn: { readonly step_index: number; readonly span_id: string | undefined },
  wire: { readonly url: string; readonly body: Record<string, unknown> },
): void {
  let data: unknown
  try {
    data = capture_copy({ url: wire.url, body: wire.body })
  } catch {
    // A body that JSON can't hold fails closed, in redact_payload.
  }
  const recorded = redact_payload(config, capture, { kind: 'wire', step_index: turn.step_index, data }, turn.span_id)
  if (recorded === undefined) return
  if (!is_record(recorded)) {
    record_capture_redaction_failed(config.trajectory, { ...turn, payload_kind: 'wire' })
    return
  }
  record_request_wire(config.trajectory, { ...turn, provider: config.provider, recorded })
}

/**
 * The `on_wire` a turn hands its adapter under capture at `'wire'`.
 */
function wire_recorder(
  config: ToolLoopConfig,
  capture: LoopCapture,
  turn: { readonly step_index: number; readonly span_id: string | undefined },
): NonNullable<TurnRequest['on_wire']> {
  return (wire) => {
    record_wire(config, capture, turn, wire)
  }
}

/**
 * Invoke the transport seam once for one turn, bracketed by request_sent /
 * response_received events, which carry the request and the reply under
 * capture, and note its cache traffic in `memory`. A thrown invoke (or
 * prepare_step) closes the step span with the error before rethrowing.
 */
async function invoke_turn(
  config: ToolLoopConfig,
  memory: CallMemory,
  step_index: number,
  step_span: string | undefined,
): Promise<TurnResult> {
  try {
    const request_messages = await apply_prepare_step(config, step_index)
    const capture = active_capture(config)
    const request =
      capture !== undefined
        ? redact_payload(
            config,
            capture,
            { kind: 'request', step_index, data: capture_request(config, capture, memory, step_index, request_messages) },
            step_span,
          )
        : undefined
    // The turn after a request that went unrecorded records its whole array.
    if (request === undefined) memory.captured_messages = undefined
    record_request_sent(config.trajectory, {
      step_index,
      span_id: step_span,
      call_span_id: config.capture?.call_span_id,
      request,
    })
    const turn = await config.invoke_once({
      step_index,
      messages: request_messages,
      tools: config.tools,
      abort: config.abort,
      stream: config.stream,
      step_span,
      ...(capture?.level === 'wire'
        ? { on_wire: wire_recorder(config, capture, { step_index, span_id: step_span }) }
        : {}),
    })
    record_response_received(
      config.trajectory,
      step_index,
      turn,
      step_span,
      capture !== undefined
        ? redact_payload(config, capture, { kind: 'response', step_index, data: capture_response(turn) }, step_span)
        : undefined,
    )
    note_cache_traffic(config, memory, turn.usage, {
      step_index,
      span_id: step_span,
      after_prepare_step: request_messages !== config.messages,
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
 * The most characters of a dropped call's input that the notice quotes.
 */
const NOTICE_INPUT_LIMIT = 120

/**
 * `text` cut to at most `limit` characters, counted by code point so that no
 * surrogate pair is split, with an ellipsis standing in for what was cut.
 */
function clip(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length <= limit ? text : `${points.slice(0, limit - 1).join('')}…`
}

/**
 * The user message that names the calls the per-step cap dropped. It's fed
 * back after the step's tool results, since the dropped calls themselves never
 * reach history, so without it the model would never learn they didn't run.
 * Each call reads as `name(input)`, with the input as JSON clipped to
 * NOTICE_INPUT_LIMIT characters. When the call has read-only tools, the
 * notice says that they don't count, or a turn that made more calls than the
 * cap would read as a contradiction.
 */
function dropped_notice(
  cap: number,
  dropped: ReadonlyArray<RawToolCall>,
  reads_exempt: boolean,
): Message {
  const one = dropped.length === 1
  const counted = one ? '1 call' : `${String(dropped.length)} calls`
  const exempt = reads_exempt ? ', not counting read-only tools' : ''
  const listed = dropped
    .map((call) => `${call.name}(${clip(safe_json_stringify(call.input), NOTICE_INPUT_LIMIT)})`)
    .join(', ')
  return {
    role: 'user',
    content:
      `${counted} didn't run, because max_tool_calls_per_step allows ${String(cap)} per turn${exempt}: ` +
      `${listed}. Make ${one ? 'it' : 'them'} again, no more than ${String(cap)} per turn.`,
  }
}

/**
 * The index of the first call past `cap`, counting only calls to tools that
 * aren't flagged read_only (an unknown name counts), or -1 when every call
 * fits.
 */
function first_over_cap(
  calls: ReadonlyArray<RawToolCall>,
  tool_map: ReadonlyMap<string, Tool>,
  cap: number,
): number {
  let counted = 0
  for (const [n, call] of calls.entries()) {
    if (tool_map.get(call.name)?.read_only === true) continue
    counted += 1
    if (counted > cap) return n
  }
  return -1
}

/**
 * A turn's calls split by the per-step cap, with the notice that names the
 * dropped ones, which is absent when nothing was dropped.
 */
type ClampedCalls = {
  readonly kept: ReadonlyArray<RawToolCall>
  readonly dropped: ReadonlyArray<RawToolCall>
  readonly notice?: Message
}

/**
 * Apply `max_tool_calls_per_step` to a turn's calls, native and salvaged
 * alike. A call to a read-only tool doesn't count. The first counted call past
 * the cap is dropped, and so is every call after it, so what runs is always a
 * prefix of what the model asked for, and nothing runs after a call that
 * didn't. Dropped calls never reach history; the notice names them instead.
 */
function clamp_calls(
  config: ToolLoopConfig,
  tool_map: ReadonlyMap<string, Tool>,
  calls: ReadonlyArray<RawToolCall>,
  step_index: number,
): ClampedCalls {
  const cap = config.max_tool_calls_per_step
  // Stryker disable next-line ConditionalExpression: with no cap, first_over_cap finds no call past it (`counted > undefined` is false) and returns -1, so every call is kept either way; the guard is what narrows `cap` for the type.
  if (cap === undefined) return { kept: calls, dropped: [] }
  const cut = first_over_cap(calls, tool_map, cap)
  if (cut === -1) return { kept: calls, dropped: [] }
  const kept = calls.slice(0, cut)
  const dropped = calls.slice(cut)
  record_tool_calls_dropped(config.trajectory, {
    step_index,
    max_tool_calls_per_step: cap,
    kept: kept.length,
    dropped: dropped.map((d) => ({ tool_call_id: d.id, name: d.name })),
  })
  const reads_exempt = config.tools.some((tool) => tool.read_only === true)
  return { kept, dropped, notice: dropped_notice(cap, dropped, reads_exempt) }
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
    build_tool_result_message(call.id, call.name, { error: message }, true),
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

  // err_message, not thrown, marks the failure: a tool may throw undefined.
  if (err_message !== undefined) {
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
 * Run one raw tool call through the guard chain (final-turn skip, tool
 * lookup, input validation, approval), then execute it. Each guard either
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
 * Build one StepRecord (cost derived and recorded, timing and
 * provider_reported passed through, `truncated` set for a turn the loop went
 * on past), push it, notify on_finish_step, and close the step span.
 */
function push_step_record(
  config: ToolLoopConfig,
  acc: LoopAccumulator,
  step_index: number,
  turn: TurnResult,
  tool_calls: ToolCallRecord[],
  finish_reason: FinishReason,
  step_span: string | undefined,
  truncated = false,
): void {
  const record: StepRecord = {
    index: step_index,
    text: turn.text,
    tool_calls,
    usage: turn.usage,
    finish_reason,
    ...(truncated ? { truncated: true } : {}),
  }
  const breakdown = compute_and_record_cost(config, step_index, turn, step_span)
  if (breakdown !== undefined) record.cost = breakdown
  if (turn.timing !== undefined) record.timing = turn.timing
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
  const turn = await invoke_turn(config, acc.memory, step_index, step_span)
  if (turn.paused === true) {
    record_turn_paused(config.trajectory, step_index, step_span)
    // A paused turn with calls runs them as a tool turn, below.
    if (turn.tool_calls.length === 0) {
      return continue_paused_turn(config, acc, step_index, step_span, turn)
    }
  }

  const view = await salvage_turn(config, turn, tool_map, step_index)
  // Salvage gets the first look at a 'length' turn, so only one that made no
  // call at all can go on as a truncated turn.
  const truncated = view.calls.length === 0 ? truncation_holder(config, turn, step_index) : undefined
  if (truncated !== undefined) {
    continue_truncated_turn(config, acc, { step_index, step_span }, turn, truncated.max_tokens)
    return undefined
  }
  const { kept, dropped, notice } = clamp_calls(config, tool_map, view.calls, step_index)
  config.messages.push(build_assistant_message(turn, view, kept))

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
  // The notice pushed below, once the loop goes on, names them instead.
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
  // Only a turn that goes on gets the notice: no later turn would read it,
  // and every call that ran has its result ahead of it.
  if (notice !== undefined) config.messages.push(notice)
  // A tool turn ends the response that any paused turns before it began.
  acc.paused_texts.length = 0
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
  const acc: LoopAccumulator = {
    steps: [],
    tool_calls: [],
    paused_texts: [],
    // Stryker disable next-line ObjectLiteral: an empty holder reads previous_cache_traffic as undefined, which the `> 0` test treats as 0, so the first turn sees the same nothing either way.
    memory: config.call_memory ?? { previous_cache_traffic: 0 },
  }
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
