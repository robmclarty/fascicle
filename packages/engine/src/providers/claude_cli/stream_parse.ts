/**
 * JSON-lines stream parser for the claude CLI stdout (spec §7).
 *
 * The parser is a line-buffered state machine with minimal state:
 *   - buffered partial line
 *   - last-seen event type (assistant | user/tool_result | system | result)
 *     used to increment step_index on the turn boundary (new assistant
 *     following a user/tool_result)
 *   - current step_index
 *
 * Malformed JSON records `{ kind: 'cli_parse_error', line }` to trajectory
 * and skips; unknown event types record `{ kind: 'cli_unknown_event', raw }`
 * and skip (spec §7.1, §7.4). Neither ever throws.
 *
 * Event shapes are Zod-validated via `cli_event_schema` (a
 * `z.discriminatedUnion` over the four CLI event types). Per-entry content
 * arrays use `.transform` to silently drop invalid entries rather than
 * rejecting the whole event — this preserves forward compatibility with
 * new CLI content types.
 */

import { z } from 'zod'
import type { TrajectoryLogger } from '@repo/core'
import type { StreamChunk, UsageTotals } from '../../types.js'

const cli_usage_schema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
})

const assistant_text_part_schema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

const assistant_tool_use_part_schema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})

const assistant_content_part_schema = z.discriminatedUnion('type', [
  assistant_text_part_schema,
  assistant_tool_use_part_schema,
])

const user_tool_result_part_schema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
})

type AssistantContentPart = z.infer<typeof assistant_content_part_schema>
type UserToolResultPart = z.infer<typeof user_tool_result_part_schema>

const assistant_content_array_schema = z.array(z.unknown()).transform((arr) => {
  const out: AssistantContentPart[] = []
  for (const entry of arr) {
    const result = assistant_content_part_schema.safeParse(entry)
    if (result.success) out.push(result.data)
  }
  return out
})

const user_content_array_schema = z.array(z.unknown()).transform((arr) => {
  const out: UserToolResultPart[] = []
  for (const entry of arr) {
    const result = user_tool_result_part_schema.safeParse(entry)
    if (result.success) out.push(result.data)
  }
  return out
})

const system_event_schema = z.object({
  type: z.literal('system'),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  model: z.string().optional(),
})

const assistant_event_schema = z.object({
  type: z.literal('assistant'),
  message: z.object({ content: assistant_content_array_schema }),
})

const user_event_schema = z.object({
  type: z.literal('user'),
  message: z.object({ content: user_content_array_schema }),
})

const result_event_schema = z.object({
  type: z.literal('result'),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  is_error: z.boolean().optional(),
  usage: cli_usage_schema.optional(),
  result: z.string().optional(),
})

const cli_event_schema = z.discriminatedUnion('type', [
  system_event_schema,
  assistant_event_schema,
  user_event_schema,
  result_event_schema,
])

export type CliUsageRaw = z.infer<typeof cli_usage_schema>
export type CliAssistantContent = AssistantContentPart
export type CliUserContent = UserToolResultPart
export type CliEvent = z.infer<typeof cli_event_schema>

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

function record_parse_error(
  trajectory: TrajectoryLogger | undefined,
  line: string,
): void {
  trajectory?.record({ kind: 'cli_parse_error', line })
}

function record_unknown_event(
  trajectory: TrajectoryLogger | undefined,
  raw: unknown,
): void {
  trajectory?.record({ kind: 'cli_unknown_event', raw })
}

function record_session_started(
  trajectory: TrajectoryLogger | undefined,
  session_id: string | undefined,
  model: string | undefined,
): void {
  trajectory?.record({ kind: 'cli_session_started', session_id, model })
}

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

function as_event(raw: unknown): CliEvent | undefined {
  const result = cli_event_schema.safeParse(raw)
  return result.success ? result.data : undefined
}

async function emit_chunk(
  chunks: StreamChunk[],
  dispatch: ((chunk: StreamChunk) => Promise<void>) | undefined,
  chunk: StreamChunk,
): Promise<void> {
  chunks.push(chunk)
  if (dispatch !== undefined) await dispatch(chunk)
}

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
  }
}

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
