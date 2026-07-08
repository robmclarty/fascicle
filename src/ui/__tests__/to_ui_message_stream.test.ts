import { describe, expect, it } from 'vitest'
import type { TrajectoryEvent } from '#core'
import type { StreamChunk } from '#engine'
import {
  close_open_blocks,
  create_ui_mapper_state,
  pipe_ui_message_stream_to_response,
  to_ui_message_chunks,
  to_ui_message_response,
} from '../to_ui_message_stream.js'
import type { RunStreamLike } from '../to_ui_message_stream.js'

function model_chunk(chunk: StreamChunk): TrajectoryEvent {
  return { kind: 'model_chunk', step_id: 'm', chunk }
}

function handle_of(
  events: TrajectoryEvent[],
  result: Promise<unknown> = Promise.resolve('done'),
): RunStreamLike {
  async function* gen(): AsyncGenerator<TrajectoryEvent> {
    for (const event of events) yield event
  }
  return { events: gen(), result }
}

describe('to_ui_message_chunks: text', () => {
  it('opens a text block once, then only deltas', () => {
    const state = create_ui_mapper_state()
    const first = to_ui_message_chunks(model_chunk({ kind: 'text', text: 'he', step_index: 0 }), state)
    const second = to_ui_message_chunks(model_chunk({ kind: 'text', text: 'llo', step_index: 0 }), state)
    expect(first).toEqual([
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'he' },
    ])
    expect(second).toEqual([{ type: 'text-delta', id: 'text-0', delta: 'llo' }])
  })

  it('closes the open text block on step_finish', () => {
    const state = create_ui_mapper_state()
    to_ui_message_chunks(model_chunk({ kind: 'text', text: 'x', step_index: 0 }), state)
    const closed = to_ui_message_chunks(
      model_chunk({ kind: 'step_finish', step_index: 0, finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }),
      state,
    )
    expect(closed).toEqual([{ type: 'text-end', id: 'text-0' }])
  })
})

describe('to_ui_message_chunks: reasoning', () => {
  it('opens a reasoning block once, then only deltas', () => {
    const state = create_ui_mapper_state()
    const first = to_ui_message_chunks(model_chunk({ kind: 'reasoning', text: 'th', step_index: 1 }), state)
    const second = to_ui_message_chunks(model_chunk({ kind: 'reasoning', text: 'ink', step_index: 1 }), state)
    expect(first).toEqual([
      { type: 'reasoning-start', id: 'reasoning-1' },
      { type: 'reasoning-delta', id: 'reasoning-1', delta: 'th' },
    ])
    expect(second).toEqual([{ type: 'reasoning-delta', id: 'reasoning-1', delta: 'ink' }])
  })
})

describe('to_ui_message_chunks: tools', () => {
  it('maps the full tool-call lifecycle and echoes the tool name at close', () => {
    const state = create_ui_mapper_state()
    const start = to_ui_message_chunks(
      model_chunk({ kind: 'tool_call_start', id: 'c1', name: 'search', step_index: 0 }),
      state,
    )
    const delta = to_ui_message_chunks(
      model_chunk({ kind: 'tool_call_input_delta', id: 'c1', delta: '{"q":', step_index: 0 }),
      state,
    )
    const end = to_ui_message_chunks(
      model_chunk({ kind: 'tool_call_end', id: 'c1', input: { q: 'x' }, step_index: 0 }),
      state,
    )
    const result = to_ui_message_chunks(
      model_chunk({ kind: 'tool_result', id: 'c1', output: { hits: 2 }, step_index: 0 }),
      state,
    )
    expect(start).toEqual([{ type: 'tool-input-start', toolCallId: 'c1', toolName: 'search' }])
    expect(delta).toEqual([{ type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"q":' }])
    expect(end).toEqual([
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'search', input: { q: 'x' } },
    ])
    expect(result).toEqual([{ type: 'tool-output-available', toolCallId: 'c1', output: { hits: 2 } }])
  })

  it('maps a tool error to tool-output-error', () => {
    const state = create_ui_mapper_state()
    const result = to_ui_message_chunks(
      model_chunk({ kind: 'tool_result', id: 'c9', error: { message: 'boom' }, step_index: 0 }),
      state,
    )
    expect(result).toEqual([{ type: 'tool-output-error', toolCallId: 'c9', errorText: 'boom' }])
  })

  it('falls back to an empty tool name when the start was never seen', () => {
    const state = create_ui_mapper_state()
    const end = to_ui_message_chunks(
      model_chunk({ kind: 'tool_call_end', id: 'orphan', input: { q: 'x' }, step_index: 0 }),
      state,
    )
    expect(end).toEqual([
      { type: 'tool-input-available', toolCallId: 'orphan', toolName: '', input: { q: 'x' } },
    ])
  })
})

describe('to_ui_message_chunks: framing and non-chunk events', () => {
  it('closes all open blocks on a top-level finish', () => {
    const state = create_ui_mapper_state()
    to_ui_message_chunks(model_chunk({ kind: 'text', text: 'a', step_index: 0 }), state)
    to_ui_message_chunks(model_chunk({ kind: 'reasoning', text: 'b', step_index: 2 }), state)
    const closed = to_ui_message_chunks(
      model_chunk({ kind: 'finish', finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }),
      state,
    )
    expect(closed).toEqual([
      { type: 'text-end', id: 'text-0' },
      { type: 'reasoning-end', id: 'reasoning-2' },
    ])
  })

  it('closes both open blocks of a step on step_finish', () => {
    const state = create_ui_mapper_state()
    to_ui_message_chunks(model_chunk({ kind: 'text', text: 'a', step_index: 0 }), state)
    to_ui_message_chunks(model_chunk({ kind: 'reasoning', text: 'b', step_index: 0 }), state)
    const closed = to_ui_message_chunks(
      model_chunk({ kind: 'step_finish', step_index: 0, finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } }),
      state,
    )
    expect(closed).toEqual([
      { type: 'text-end', id: 'text-0' },
      { type: 'reasoning-end', id: 'reasoning-0' },
    ])
  })

  it('ignores non-model_chunk events and non-chunk payloads', () => {
    const state = create_ui_mapper_state()
    expect(to_ui_message_chunks({ kind: 'span_start', span_id: 's', name: 'sequence' }, state)).toEqual([])
    expect(to_ui_message_chunks({ kind: 'emit', text: 'hi' }, state)).toEqual([])
    expect(to_ui_message_chunks({ kind: 'model_chunk', chunk: 42 }, state)).toEqual([])
    expect(to_ui_message_chunks({ kind: 'model_chunk', chunk: null }, state)).toEqual([])
    expect(to_ui_message_chunks({ kind: 'model_chunk', chunk: {} }, state)).toEqual([])
    expect(to_ui_message_chunks({ kind: 'model_chunk', chunk: { kind: 7 } }, state)).toEqual([])
    expect(to_ui_message_chunks({ kind: 'model_chunk', chunk: { kind: 'nope' } }, state)).toEqual([])
    expect(to_ui_message_chunks({ kind: 'model_chunk' }, state)).toEqual([])
  })

  it('close_open_blocks empties the state and is idempotent', () => {
    const state = create_ui_mapper_state()
    to_ui_message_chunks(model_chunk({ kind: 'text', text: 'a', step_index: 0 }), state)
    expect(close_open_blocks(state)).toEqual([{ type: 'text-end', id: 'text-0' }])
    expect(close_open_blocks(state)).toEqual([])
  })
})

describe('to_ui_message_response: end to end through the ai builders', () => {
  it('produces an SSE UI-message-stream Response with the mapped parts', async () => {
    const res = to_ui_message_response(
      handle_of([
        model_chunk({ kind: 'text', text: 'he', step_index: 0 }),
        model_chunk({ kind: 'text', text: 'llo', step_index: 0 }),
      ]),
    )
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1')
    const body = await res.text()
    expect(body).toContain('"type":"text-start"')
    expect(body).toContain('"delta":"he"')
    expect(body).toContain('"delta":"llo"')
    expect(body).toContain('"type":"text-end"')
    expect(body).toContain('[DONE]')
  })

  it('surfaces a rejected run result as an error part via on_error', async () => {
    const res = to_ui_message_response(
      handle_of([model_chunk({ kind: 'text', text: 'x', step_index: 0 })], Promise.reject(new Error('nope'))),
      { on_error: (e) => (e instanceof Error ? e.message : 'unknown') },
    )
    const body = await res.text()
    expect(body).toContain('"type":"error"')
    expect(body).toContain('nope')
  })

  it('pipes to a node ServerResponse-like sink', async () => {
    const written: string[] = []
    const headers: Record<string, unknown> = {}
    const decoder = new TextDecoder()
    let ended = false
    const fake_response = {
      write: (chunk: unknown) => {
        written.push(chunk instanceof Uint8Array ? decoder.decode(chunk, { stream: true }) : String(chunk))
        return true
      },
      writeHead: (_status: number, hdrs?: Record<string, unknown>) => {
        if (hdrs) Object.assign(headers, hdrs)
      },
      setHeader: (name: string, value: unknown) => {
        headers[name] = value
      },
      end: () => {
        ended = true
      },
      on: () => {},
      once: () => {},
      emit: () => {},
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    pipe_ui_message_stream_to_response(
      handle_of([model_chunk({ kind: 'text', text: 'hi', step_index: 0 })]),
      fake_response as unknown as Parameters<typeof pipe_ui_message_stream_to_response>[1],
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ended).toBe(true)
    expect(written.join('')).toContain('"delta":"hi"')
  })
})
