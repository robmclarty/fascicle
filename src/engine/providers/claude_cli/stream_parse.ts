/**
 * JSON-lines stream parser for the claude CLI stdout.
 *
 * The CLI (run with `--output-format stream-json`) writes one JSON event per
 * line: `system` (session init), `assistant` (model output), `user` (tool
 * results echoed back into the conversation), `result` (the single terminal
 * event carrying totals), and `rate_limit_event` (informational rate-limit
 * budget report). The parser is a line-buffered state machine with minimal
 * state:
 *   - buffered partial line
 *   - last-seen event type (assistant | user/tool_result | system | result);
 *     an `assistant` event that follows a user/tool_result marks a turn
 *     boundary and increments `step_index`
 *   - current `step_index`
 *
 * Malformed JSON records `{ kind: 'cli_parse_error', line }` to trajectory
 * and skips; unknown event types record `{ kind: 'cli_unknown_event', raw }`
 * and skip. Neither ever throws.
 *
 * Event shapes are validated by hand-written type guards. `as_event` is the
 * discriminated gate over the recognized CLI event types: a value must be a
 * non-array object whose `type` names a known event, and that event's own
 * fields must type-check, or the whole line is rejected as `cli_unknown_event`.
 * This mirrors the strictness of the `z.discriminatedUnion` it replaced: an
 * optional field carrying the wrong type rejects the event, unknown keys ride
 * along unused, and a sub-object (`usage`, `rate_limit_info`) is validated field
 * by field. Per-entry content arrays are the one deliberately permissive layer:
 * `as_assistant_part` / `as_user_part` recognize a single entry at a time and
 * the collector drops the ones that don't match, so a content type a future CLI
 * emits never rejects the surrounding event.
 */

import type { TrajectoryLogger } from '#core'
import type { StreamChunk, UsageTotals } from '../../types.js'

export type CliUsageRaw = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

type CliTextPart = { type: 'text'; text: string }
type CliToolUsePart = { type: 'tool_use'; id: string; name: string; input: unknown }
export type CliAssistantContent = CliTextPart | CliToolUsePart

export type CliUserContent = {
  type: 'tool_result'
  tool_use_id: string
  content?: unknown
  is_error?: boolean
}

type CliSystemEvent = {
  type: 'system'
  subtype?: string
  session_id?: string
  model?: string
}

type CliAssistantEvent = {
  type: 'assistant'
  message: { content: CliAssistantContent[] }
}

type CliUserEvent = {
  type: 'user'
  message: { content: CliUserContent[] }
}

type CliResultEvent = {
  type: 'result'
  subtype?: string
  session_id?: string
  total_cost_usd?: number
  duration_ms?: number
  is_error?: boolean
  usage?: CliUsageRaw
  result?: string
}

type CliRateLimitInfo = {
  status?: string
  resetsAt?: number
  rateLimitType?: string
  overageStatus?: string
  overageResetsAt?: number
  isUsingOverage?: boolean
}

type CliRateLimitEvent = {
  type: 'rate_limit_event'
  rate_limit_info?: CliRateLimitInfo
  session_id?: string
}

export type CliEvent =
  | CliSystemEvent
  | CliAssistantEvent
  | CliUserEvent
  | CliResultEvent
  | CliRateLimitEvent

/** A non-null, non-array object: the shape every CLI event and sub-object takes. */
function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `key` is absent (or `undefined`), or holds a string. */
function opt_string(rec: Record<string, unknown>, key: string): boolean {
  const value = rec[key]
  return value === undefined || typeof value === 'string'
}

/** `key` is absent (or `undefined`), or holds a number. */
function opt_number(rec: Record<string, unknown>, key: string): boolean {
  const value = rec[key]
  return value === undefined || typeof value === 'number'
}

/** `key` is absent (or `undefined`), or holds a boolean. */
function opt_boolean(rec: Record<string, unknown>, key: string): boolean {
  const value = rec[key]
  return value === undefined || typeof value === 'boolean'
}

/**
 * The optional `usage` sub-object of a `result` event. Absent is fine; a present
 * value must be an object whose known token counts are numbers when given. A
 * `null`, an array, or a mistyped count rejects the event.
 */
function is_valid_usage(value: unknown): boolean {
  if (value === undefined) return true
  if (!is_record(value)) return false
  return (
    opt_number(value, 'input_tokens') &&
    opt_number(value, 'output_tokens') &&
    opt_number(value, 'cache_read_input_tokens') &&
    opt_number(value, 'cache_creation_input_tokens')
  )
}

/**
 * The optional `rate_limit_info` sub-object of a `rate_limit_event`, under the
 * same rule as usage: absent is fine, a present value is validated field by
 * field or the event is rejected.
 */
function is_valid_rate_limit_info(value: unknown): boolean {
  if (value === undefined) return true
  if (!is_record(value)) return false
  return (
    opt_string(value, 'status') &&
    opt_number(value, 'resetsAt') &&
    opt_string(value, 'rateLimitType') &&
    opt_string(value, 'overageStatus') &&
    opt_number(value, 'overageResetsAt') &&
    opt_boolean(value, 'isUsingOverage')
  )
}

/**
 * Recognize one `assistant` content entry, or `undefined` for anything
 * unrecognized. `text` needs a string `text`; `tool_use` needs string `id` and
 * `name` and carries its opaque `input` through (absent `input` becomes
 * `undefined`, one deliberate tolerance the old `z.unknown()` did not grant).
 * Callers drop the `undefined` results, so an unknown entry type never rejects
 * the surrounding event.
 */
function as_assistant_part(value: unknown): CliAssistantContent | undefined {
  if (!is_record(value)) return undefined
  if (value['type'] === 'text') {
    const text = value['text']
    return typeof text === 'string' ? { type: 'text', text } : undefined
  }
  if (value['type'] === 'tool_use') {
    const id = value['id']
    const name = value['name']
    if (typeof id !== 'string') return undefined
    if (typeof name !== 'string') return undefined
    return { type: 'tool_use', id, name, input: value['input'] }
  }
  return undefined
}

/**
 * Recognize one `user` content entry as a tool result, or `undefined`. Requires
 * a string `tool_use_id`; `is_error` must be boolean when present, and a present
 * `content` of any shape is carried through. Callers drop the `undefined`
 * results.
 */
function as_user_part(value: unknown): CliUserContent | undefined {
  if (!is_record(value)) return undefined
  if (value['type'] !== 'tool_result') return undefined
  const tool_use_id = value['tool_use_id']
  if (typeof tool_use_id !== 'string') return undefined
  if (!opt_boolean(value, 'is_error')) return undefined
  const part: CliUserContent = { type: 'tool_result', tool_use_id }
  if ('content' in value) part.content = value['content']
  const is_error = value['is_error']
  if (typeof is_error === 'boolean') part.is_error = is_error
  return part
}

/**
 * Collect the valid parts of an `assistant`/`user` content array. Returns
 * `undefined` (rejecting the event) when `value` is not an array; otherwise maps
 * each entry through `recognize` and keeps the ones it accepts.
 */
function collect_parts<T>(
  value: unknown,
  recognize: (entry: unknown) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parts: T[] = []
  for (const entry of value) {
    const part = recognize(entry)
    if (part !== undefined) parts.push(part)
  }
  return parts
}

/** A `system` event whose optional metadata fields type-check. */
function is_system_event(raw: Record<string, unknown>): raw is CliSystemEvent {
  return (
    opt_string(raw, 'subtype') &&
    opt_string(raw, 'session_id') &&
    opt_string(raw, 'model')
  )
}

/** A `result` event whose optional fields and `usage` sub-object type-check. */
function is_result_event(raw: Record<string, unknown>): raw is CliResultEvent {
  return (
    opt_string(raw, 'subtype') &&
    opt_string(raw, 'session_id') &&
    opt_number(raw, 'total_cost_usd') &&
    opt_number(raw, 'duration_ms') &&
    opt_boolean(raw, 'is_error') &&
    is_valid_usage(raw['usage']) &&
    opt_string(raw, 'result')
  )
}

/** A `rate_limit_event` whose `rate_limit_info` sub-object and `session_id` type-check. */
function is_rate_limit_event(raw: Record<string, unknown>): raw is CliRateLimitEvent {
  return is_valid_rate_limit_info(raw['rate_limit_info']) && opt_string(raw, 'session_id')
}

/**
 * Recognize a pass-through event in place: hand the original object back (extra
 * keys and all, since nothing downstream reads them) when `recognize` accepts
 * it, or `undefined` to reject. Narrowing keeps this cast-free.
 */
function gate<T extends CliEvent>(
  raw: Record<string, unknown>,
  recognize: (value: Record<string, unknown>) => value is T,
): T | undefined {
  return recognize(raw) ? raw : undefined
}

/**
 * Normalize an `assistant` event: its `message` must be an object and its
 * `content` an array, whose recognized parts are kept and the rest dropped.
 */
function as_assistant_event(raw: Record<string, unknown>): CliEvent | undefined {
  const message = raw['message']
  if (!is_record(message)) return undefined
  const content = collect_parts(message['content'], as_assistant_part)
  return content === undefined ? undefined : { type: 'assistant', message: { content } }
}

/** Normalize a `user` event, under the same rule as `as_assistant_event`. */
function as_user_event(raw: Record<string, unknown>): CliEvent | undefined {
  const message = raw['message']
  if (!is_record(message)) return undefined
  const content = collect_parts(message['content'], as_user_part)
  return content === undefined ? undefined : { type: 'user', message: { content } }
}

/**
 * The wire gate: validate a parsed JSON value against the recognized CLI event
 * shapes, returning the typed event or `undefined` on any mismatch.
 *
 * `assistant` and `user` are normalized (their content arrays are filtered down
 * to the recognized parts); the pass-through events are recognized in place, so
 * unknown keys survive but are never read.
 */
function as_event(raw: unknown): CliEvent | undefined {
  if (!is_record(raw)) return undefined
  switch (raw['type']) {
    case 'system':
      return gate(raw, is_system_event)
    case 'assistant':
      return as_assistant_event(raw)
    case 'user':
      return as_user_event(raw)
    case 'result':
      return gate(raw, is_result_event)
    case 'rate_limit_event':
      return gate(raw, is_rate_limit_event)
    default:
      return undefined
  }
}

export type TurnCollected = {
  readonly step_index: number
  readonly text: string
  readonly tool_calls: ReadonlyArray<{ id: string; name: string; input: unknown }>
  readonly tool_results: ReadonlyArray<{
    id: string
    output?: unknown
    error?: { message: string }
  }>
  readonly usage: UsageTotals
}

export type ParsedStream = {
  readonly session_id?: string
  readonly total_cost_usd?: number
  readonly duration_ms?: number
  readonly final_text: string
  readonly final_usage: UsageTotals
  readonly turns: ReadonlyArray<TurnCollected>
  readonly is_error: boolean
  readonly received_result: boolean
}

type ParserState = {
  buffer: string
  last_event_type: 'assistant' | 'user_tool_result' | 'system' | 'result' | 'none'
  current_step_index: number
  session_id?: string
  total_cost_usd?: number
  duration_ms?: number
  final_text: string
  final_usage: UsageTotals
  turns: TurnCollected[]
  turn_text: string
  turn_tool_calls: Array<{ id: string; name: string; input: unknown }>
  turn_tool_results: Array<{
    id: string
    output?: unknown
    error?: { message: string }
  }>
  turn_usage: UsageTotals
  is_error: boolean
  received_result: boolean
}

/**
 * Build a fresh, empty `ParserState` for one CLI invocation.
 */
export function create_parser_state(): ParserState {
  return {
    buffer: '',
    last_event_type: 'none',
    current_step_index: 0,
    final_text: '',
    final_usage: { input_tokens: 0, output_tokens: 0 },
    turns: [],
    turn_text: '',
    turn_tool_calls: [],
    turn_tool_results: [],
    turn_usage: { input_tokens: 0, output_tokens: 0 },
    is_error: false,
    received_result: false,
  }
}

/**
 * Convert the CLI's raw usage fields to fascicle's `UsageTotals` shape.
 *
 * `cache_read_input_tokens` maps to `cached_input_tokens` and
 * `cache_creation_input_tokens` maps to `cache_write_tokens`; both are
 * omitted when the CLI didn't report them.
 */
function map_usage(raw: CliUsageRaw | undefined): UsageTotals {
  if (raw === undefined) return { input_tokens: 0, output_tokens: 0 }
  const out: UsageTotals = {
    input_tokens: typeof raw.input_tokens === 'number' ? raw.input_tokens : 0,
    output_tokens: typeof raw.output_tokens === 'number' ? raw.output_tokens : 0,
  }
  if (typeof raw.cache_read_input_tokens === 'number') {
    out.cached_input_tokens = raw.cache_read_input_tokens
  }
  if (typeof raw.cache_creation_input_tokens === 'number') {
    out.cache_write_tokens = raw.cache_creation_input_tokens
  }
  return out
}

/**
 * Record a line that failed to parse as JSON to the trajectory logger.
 */
function record_parse_error(
  trajectory: TrajectoryLogger | undefined,
  line: string,
): void {
  trajectory?.record({ kind: 'cli_parse_error', line })
}

/**
 * Record a parsed-but-unrecognized CLI event to the trajectory logger.
 */
function record_unknown_event(
  trajectory: TrajectoryLogger | undefined,
  raw: unknown,
): void {
  trajectory?.record({ kind: 'cli_unknown_event', raw })
}

/**
 * Record the CLI's `system` (session init) event to the trajectory logger.
 */
function record_session_started(
  trajectory: TrajectoryLogger | undefined,
  session_id: string | undefined,
  model: string | undefined,
): void {
  trajectory?.record({ kind: 'cli_session_started', session_id, model })
}

/**
 * Record a `rate_limit_event` to the trajectory logger.
 */
function record_rate_limit(
  trajectory: TrajectoryLogger | undefined,
  event: Extract<CliEvent, { type: 'rate_limit_event' }>,
): void {
  const info = event.rate_limit_info
  trajectory?.record({
    kind: 'cli_rate_limit_event',
    session_id: event.session_id,
    status: info?.status,
    rate_limit_type: info?.rateLimitType,
    resets_at: info?.resetsAt,
    overage_status: info?.overageStatus,
    overage_resets_at: info?.overageResetsAt,
    is_using_overage: info?.isUsingOverage,
  })
}

/**
 * Push the in-progress turn onto `state.turns` and reset the per-turn
 * accumulators for the next turn.
 */
function flush_turn(state: ParserState): void {
  state.turns.push({
    step_index: state.current_step_index,
    text: state.turn_text,
    tool_calls: state.turn_tool_calls.slice(),
    tool_results: state.turn_tool_results.slice(),
    usage: { ...state.turn_usage },
  })
  state.turn_text = ''
  state.turn_tool_calls = []
  state.turn_tool_results = []
  state.turn_usage = { input_tokens: 0, output_tokens: 0 }
}

/**
 * Append a `StreamChunk` to the output array and, if the caller passed an
 * `on_chunk` dispatcher, await its delivery too.
 */
async function emit_chunk(
  chunks: StreamChunk[],
  dispatch: ((chunk: StreamChunk) => Promise<void>) | undefined,
  chunk: StreamChunk,
): Promise<void> {
  chunks.push(chunk)
  if (dispatch !== undefined) await dispatch(chunk)
}

/**
 * Handle one `assistant` event: emit `text`, `tool_call_start`, and
 * `tool_call_end` chunks for its content and accumulate them onto the
 * current turn.
 *
 * An `assistant` event that follows a `user`/tool-result event marks a new
 * turn boundary: it first emits a synthetic `step_finish` chunk for the
 * turn that just ended, flushes that turn onto `state.turns`, and advances
 * `current_step_index`.
 */
async function handle_assistant(
  state: ParserState,
  event: Extract<CliEvent, { type: 'assistant' }>,
  chunks: StreamChunk[],
  dispatch: ((chunk: StreamChunk) => Promise<void>) | undefined,
): Promise<void> {
  if (state.last_event_type === 'user_tool_result') {
    const usage = { ...state.turn_usage }
    await emit_chunk(chunks, dispatch, {
      kind: 'step_finish',
      step_index: state.current_step_index,
      finish_reason: 'tool_calls',
      usage,
    })
    flush_turn(state)
    state.current_step_index += 1
  }

  for (const part of event.message.content) {
    if (part.type === 'text') {
      state.turn_text += part.text
      state.final_text += part.text
      await emit_chunk(chunks, dispatch, {
        kind: 'text',
        text: part.text,
        step_index: state.current_step_index,
      })
      continue
    }
    state.turn_tool_calls.push({ id: part.id, name: part.name, input: part.input })
    await emit_chunk(chunks, dispatch, {
      kind: 'tool_call_start',
      id: part.id,
      name: part.name,
      step_index: state.current_step_index,
    })
    await emit_chunk(chunks, dispatch, {
      kind: 'tool_call_end',
      id: part.id,
      input: part.input,
      step_index: state.current_step_index,
    })
  }
  state.last_event_type = 'assistant'
}

/**
 * Handle one `user` event: emit a `tool_result` chunk for each tool result
 * in its content and accumulate them onto the current turn.
 */
async function handle_user(
  state: ParserState,
  event: Extract<CliEvent, { type: 'user' }>,
  chunks: StreamChunk[],
  dispatch: ((chunk: StreamChunk) => Promise<void>) | undefined,
): Promise<void> {
  for (const part of event.message.content) {
    if (part.type !== 'tool_result') continue
    const is_err = part.is_error === true
    const stream_chunk: StreamChunk = {
      kind: 'tool_result',
      id: part.tool_use_id,
      step_index: state.current_step_index,
    }
    if (is_err) {
      const content_str =
        typeof part.content === 'string' ? part.content : JSON.stringify(part.content)
      stream_chunk.error = { message: content_str }
      state.turn_tool_results.push({
        id: part.tool_use_id,
        error: { message: content_str },
      })
    } else {
      stream_chunk.output = part.content
      state.turn_tool_results.push({ id: part.tool_use_id, output: part.content })
    }
    await emit_chunk(chunks, dispatch, stream_chunk)
  }
  state.last_event_type = 'user_tool_result'
}

/**
 * Handle the terminal `result` event: capture the call's session id, cost,
 * duration, and final usage, flush the last in-progress turn, and emit the
 * closing `finish` chunk.
 *
 * Falls back to `event.result` for `final_text` only when no assistant
 * text was collected during the stream.
 */
async function handle_result(
  state: ParserState,
  event: Extract<CliEvent, { type: 'result' }>,
  chunks: StreamChunk[],
  dispatch: ((chunk: StreamChunk) => Promise<void>) | undefined,
): Promise<void> {
  state.received_result = true
  if (typeof event.session_id === 'string') state.session_id = event.session_id
  if (typeof event.total_cost_usd === 'number') state.total_cost_usd = event.total_cost_usd
  if (typeof event.duration_ms === 'number') state.duration_ms = event.duration_ms
  if (event.is_error === true) state.is_error = true
  const usage = map_usage(event.usage)
  state.final_usage = usage
  state.turn_usage = { ...usage }
  if (typeof event.result === 'string' && event.result.length > 0) {
    if (state.final_text.length === 0) state.final_text = event.result
  }
  flush_turn(state)
  state.last_event_type = 'result'
  await emit_chunk(chunks, dispatch, {
    kind: 'finish',
    finish_reason: 'stop',
    usage,
  })
}

/**
 * Dispatch one validated `CliEvent` to its type-specific handler.
 */
async function handle_event(
  state: ParserState,
  event: CliEvent,
  chunks: StreamChunk[],
  dispatch: ((chunk: StreamChunk) => Promise<void>) | undefined,
  trajectory: TrajectoryLogger | undefined,
): Promise<void> {
  switch (event.type) {
    case 'system':
      record_session_started(trajectory, event.session_id, event.model)
      if (typeof event.session_id === 'string' && state.session_id === undefined) {
        state.session_id = event.session_id
      }
      state.last_event_type = 'system'
      return
    case 'assistant':
      await handle_assistant(state, event, chunks, dispatch)
      return
    case 'user':
      await handle_user(state, event, chunks, dispatch)
      return
    case 'result':
      await handle_result(state, event, chunks, dispatch)
      return
    case 'rate_limit_event':
      record_rate_limit(trajectory, event)
      return
  }
}

/**
 * Parse and handle one line of CLI stdout.
 *
 * Blank lines are skipped. Lines that aren't valid JSON, or that don't
 * match any known event shape, are recorded to the trajectory logger and
 * otherwise ignored; this function never throws.
 */
export async function consume_line(
  state: ParserState,
  line: string,
  chunks: StreamChunk[],
  dispatch: ((chunk: StreamChunk) => Promise<void>) | undefined,
  trajectory: TrajectoryLogger | undefined,
): Promise<void> {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    record_parse_error(trajectory, line)
    return
  }
  const event = as_event(parsed)
  if (event === undefined) {
    record_unknown_event(trajectory, parsed)
    return
  }
  await handle_event(state, event, chunks, dispatch, trajectory)
}

/**
 * Append raw stdout text to the parser's line buffer and consume every
 * complete line it now contains.
 *
 * Any trailing partial line (no `\n` yet) stays buffered for the next
 * call.
 */
export async function feed_chunk(
  state: ParserState,
  chunk: string,
  chunks: StreamChunk[],
  dispatch: ((chunk: StreamChunk) => Promise<void>) | undefined,
  trajectory: TrajectoryLogger | undefined,
): Promise<void> {
  state.buffer += chunk
  let nl_index = state.buffer.indexOf('\n')
  while (nl_index !== -1) {
    const line = state.buffer.slice(0, nl_index)
    state.buffer = state.buffer.slice(nl_index + 1)
    await consume_line(state, line, chunks, dispatch, trajectory)
    nl_index = state.buffer.indexOf('\n')
  }
}

/**
 * Consume a final buffered line that has no trailing newline.
 *
 * `feed_chunk` only parses complete `\n`-terminated lines, so a trailing
 * unterminated fragment stays in the buffer until the caller knows the
 * stream has actually ended. Call this once, after the last `feed_chunk`,
 * to parse that fragment as one last line.
 */
export async function flush_remaining(
  state: ParserState,
  chunks: StreamChunk[],
  dispatch: ((chunk: StreamChunk) => Promise<void>) | undefined,
  trajectory: TrajectoryLogger | undefined,
): Promise<void> {
  if (state.buffer.length === 0) return
  const line = state.buffer
  state.buffer = ''
  await consume_line(state, line, chunks, dispatch, trajectory)
}

/**
 * Take an immutable copy of the parser state's accumulated results as a
 * `ParsedStream`.
 */
export function snapshot(state: ParserState): ParsedStream {
  const base: {
    final_text: string
    final_usage: UsageTotals
    turns: ReadonlyArray<TurnCollected>
    is_error: boolean
    received_result: boolean
    session_id?: string
    total_cost_usd?: number
    duration_ms?: number
  } = {
    final_text: state.final_text,
    final_usage: { ...state.final_usage },
    turns: state.turns.slice(),
    is_error: state.is_error,
    received_result: state.received_result,
  }
  if (state.session_id !== undefined) base.session_id = state.session_id
  if (state.total_cost_usd !== undefined) base.total_cost_usd = state.total_cost_usd
  if (state.duration_ms !== undefined) base.duration_ms = state.duration_ms
  return base
}
