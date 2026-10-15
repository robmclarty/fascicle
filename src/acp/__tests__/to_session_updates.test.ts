import { describe, expect, it } from 'vitest'
import type { TrajectoryEvent } from '#core'
import type { StreamChunk } from '#engine'
import { create_acp_mapper_state, to_session_updates } from '../to_session_updates.js'
import type { AcpMapperState, AcpStreamRoute } from '../types.js'

function model_chunk(chunk: StreamChunk, step_id = 'm'): TrajectoryEvent {
  return { kind: 'model_chunk', step_id, chunk }
}

const usage = { input_tokens: 1, output_tokens: 1 }

describe('to_session_updates: text routing', () => {
  it('sends text as an agent message by default', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    const updates = to_session_updates(model_chunk({ kind: 'text', text: 'hi', step_index: 0 }), state)
    expect(updates).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }])
  })

  it.each<[AcpStreamRoute, unknown[]]>([
    ['message', [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }]],
    ['thought', [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'x' } }]],
    ['none', []],
  ])('routes a call whose stream says %s', (route, expected) => {
    const state = create_acp_mapper_state({ turn_id: 't1', stream: () => route })
    expect(to_session_updates(model_chunk({ kind: 'text', text: 'x', step_index: 0 }), state)).toEqual(expected)
  })

  it('routes each model call by its own step_id', () => {
    const seen: string[] = []
    const state = create_acp_mapper_state({
      turn_id: 't1',
      stream: (step_id) => {
        seen.push(step_id)
        return step_id === 'draft' ? 'thought' : 'message'
      },
    })
    const draft = to_session_updates(model_chunk({ kind: 'text', text: 'a', step_index: 0 }, 'draft'), state)
    const reply = to_session_updates(model_chunk({ kind: 'text', text: 'b', step_index: 0 }, 'reply'), state)
    expect(seen).toEqual(['draft', 'reply'])
    expect(draft).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'a' } }])
    expect(reply).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' } }])
  })
})

describe('to_session_updates: reasoning', () => {
  it('sends reasoning as a thought whatever the text route says', () => {
    const state = create_acp_mapper_state({ turn_id: 't1', stream: () => 'none' })
    const updates = to_session_updates(model_chunk({ kind: 'reasoning', text: 'hmm', step_index: 0 }), state)
    expect(updates).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }])
  })
})

describe('to_session_updates: tool calls', () => {
  it('opens a pending card titled with the tool name', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    const updates = to_session_updates(
      model_chunk({ kind: 'tool_call_start', id: 'c1', name: 'lookup', step_index: 0 }),
      state,
    )
    expect(updates).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 't1:m:c1', title: 'lookup', kind: 'other', status: 'pending' },
    ])
  })

  it('sends nothing for input deltas', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    const updates = to_session_updates(
      model_chunk({ kind: 'tool_call_input_delta', id: 'c1', delta: '{"q":', step_index: 0 }),
      state,
    )
    expect(updates).toEqual([])
  })

  it('marks the card in progress with the whole input once it ends', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    const updates = to_session_updates(
      model_chunk({ kind: 'tool_call_end', id: 'c1', input: { q: 'x' }, step_index: 0 }),
      state,
    )
    expect(updates).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 't1:m:c1', status: 'in_progress', rawInput: { q: 'x' } },
    ])
  })

  it('completes the card with the raw output', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    const updates = to_session_updates(
      model_chunk({ kind: 'tool_result', id: 'c1', output: { hits: 2 }, step_index: 0 }),
      state,
    )
    expect(updates).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 't1:m:c1', status: 'completed', rawOutput: { hits: 2 } },
    ])
  })

  it('fails the card with the error text as its content', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    const updates = to_session_updates(
      model_chunk({ kind: 'tool_result', id: 'c1', error: { message: 'no such file: a.ts' }, step_index: 0 }),
      state,
    )
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1:m:c1',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'no such file: a.ts' } }],
      },
    ])
  })
})

describe('to_session_updates: tool call ids', () => {
  const start = (step_id: string): TrajectoryEvent =>
    model_chunk({ kind: 'tool_call_start', id: 'ollama_call_0_0', name: 'lookup', step_index: 0 }, step_id)

  function id_of(event: TrajectoryEvent, state: AcpMapperState): unknown {
    const [update] = to_session_updates(event, state)
    return update === undefined ? undefined : Reflect.get(update, 'toolCallId')
  }

  it('keeps two model calls that report the same raw id apart', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    expect(id_of(start('first'), state)).toBe('t1:first:ollama_call_0_0')
    expect(id_of(start('second'), state)).toBe('t1:second:ollama_call_0_0')
  })

  it('keeps two turns that report the same raw id apart', () => {
    const one = create_acp_mapper_state({ turn_id: 't1' })
    const two = create_acp_mapper_state({ turn_id: 't2' })
    expect(id_of(start('m'), one)).toBe('t1:m:ollama_call_0_0')
    expect(id_of(start('m'), two)).toBe('t2:m:ollama_call_0_0')
  })

  it('gives each turn a fresh random id when none is passed', () => {
    const one = id_of(start('m'), create_acp_mapper_state())
    const two = id_of(start('m'), create_acp_mapper_state())
    expect(one).toMatch(/^[0-9a-f-]{36}:m:ollama_call_0_0$/)
    expect(two).toMatch(/^[0-9a-f-]{36}:m:ollama_call_0_0$/)
    expect(one).not.toBe(two)
  })

  it('carries the same id from start through end to result', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    const ids = [
      id_of(model_chunk({ kind: 'tool_call_start', id: 'c1', name: 'lookup', step_index: 0 }), state),
      id_of(model_chunk({ kind: 'tool_call_end', id: 'c1', input: {}, step_index: 0 }), state),
      id_of(model_chunk({ kind: 'tool_result', id: 'c1', output: 'ok', step_index: 0 }), state),
    ]
    expect(ids).toEqual(['t1:m:c1', 't1:m:c1', 't1:m:c1'])
  })
})

describe('to_session_updates: events that send nothing', () => {
  it.each<[string, StreamChunk]>([
    ['step_finish', { kind: 'step_finish', step_index: 0, finish_reason: 'stop', usage }],
    ['finish', { kind: 'finish', finish_reason: 'stop', usage }],
  ])('maps a %s chunk to nothing', (_name, chunk) => {
    expect(to_session_updates(model_chunk(chunk), create_acp_mapper_state({ turn_id: 't1' }))).toEqual([])
  })

  it.each<[string, TrajectoryEvent]>([
    ['a span start', { kind: 'span_start', span_id: 's1', name: 'flow' }],
    ['a span end', { kind: 'span_end', span_id: 's1' }],
    ['a cost event', { kind: 'cost', step_index: 0, total_usd: 0.01 }],
    ['an emit', { kind: 'emit', text: 'hello' }],
    [
      'an emit shaped like a model chunk',
      { kind: 'emit', step_id: 'm', chunk: { kind: 'text', text: 'hi', step_index: 0 } },
    ],
  ])('maps %s to nothing', (_name, event) => {
    expect(to_session_updates(event, create_acp_mapper_state({ turn_id: 't1' }))).toEqual([])
  })

  it.each<[string, TrajectoryEvent]>([
    ['no step_id', { kind: 'model_chunk', chunk: { kind: 'text', text: 'hi', step_index: 0 } }],
    ['no chunk', { kind: 'model_chunk', step_id: 'm' }],
    ['a null chunk', { kind: 'model_chunk', step_id: 'm', chunk: null }],
    ['a chunk of a kind it does not know', { kind: 'model_chunk', step_id: 'm', chunk: { kind: 'image' } }],
  ])('maps a model_chunk with %s to nothing', (_name, event) => {
    expect(to_session_updates(event, create_acp_mapper_state({ turn_id: 't1' }))).toEqual([])
  })
})

describe('to_session_updates: purity', () => {
  it('maps the same event the same way every time and leaves the state alone', () => {
    const state = Object.freeze(create_acp_mapper_state({ turn_id: 't1' }))
    const event = model_chunk({ kind: 'tool_call_start', id: 'c1', name: 'lookup', step_index: 0 })
    expect(to_session_updates(event, state)).toEqual(to_session_updates(event, state))
    expect(state.turn_id).toBe('t1')
  })
})
