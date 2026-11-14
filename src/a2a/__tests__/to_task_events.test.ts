import { describe, expect, it } from 'vitest'
import type { AgentExecutionEvent } from '@a2a-js/sdk/server'
import type { TrajectoryEvent } from '#core'
import { data_part, text_part } from '../parts.js'
import { create_a2a_mapper_state, end_task_events, has_streamed, to_task_events } from '../to_task_events.js'
import type { A2aMapperState } from '../types.js'

const IDS = { task_id: 'task-1', context_id: 'ctx-1', artifact_id: 'art-1' } as const

function text_chunk(step_id: string, text: string): TrajectoryEvent {
  return { kind: 'model_chunk', step_id, chunk: { kind: 'text', text, step_index: 0 } }
}

// Map every event in order, as a drive does.
function map_all(state: A2aMapperState, events: ReadonlyArray<TrajectoryEvent>): AgentExecutionEvent[] {
  return events.flatMap((event) => to_task_events(event, state))
}

// What each artifact update carries, without the ids every one repeats.
function chunks_of(events: ReadonlyArray<AgentExecutionEvent>) {
  return events.map((event) => {
    if (event.kind !== 'artifactUpdate') throw new Error(`unexpected ${event.kind} event`)
    return { parts: event.data.artifact?.parts, append: event.data.append, last: event.data.lastChunk }
  })
}

describe('create_a2a_mapper_state', () => {
  it('routes every call to the artifact, and draws an artifact id, unless told otherwise', () => {
    const state = create_a2a_mapper_state({ task_id: 't', context_id: 'c' })
    expect(state.stream('any')).toBe('artifact')
    expect(state.artifact_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(create_a2a_mapper_state({ task_id: 't', context_id: 'c' }).artifact_id).not.toBe(state.artifact_id)
    expect(state).toMatchObject({ task_id: 't', context_id: 'c', pending: undefined, sent: 0 })
    expect(state.replaying.size).toBe(0)
  })

  it('keeps the artifact id and the route it was given', () => {
    const state = create_a2a_mapper_state({ ...IDS, stream: (id) => (id === 'draft' ? 'none' : 'artifact') })
    expect(state.artifact_id).toBe('art-1')
    expect(state.stream('draft')).toBe('none')
    expect(state.stream('final')).toBe('artifact')
  })
})

describe('to_task_events text', () => {
  it('holds the newest chunk back, appends every chunk after the first, and marks only the last', () => {
    const state = create_a2a_mapper_state(IDS)
    expect(to_task_events(text_chunk('write', 'one '), state)).toEqual([])
    const middle = map_all(state, [text_chunk('write', 'two '), text_chunk('write', 'three')])
    const closing = end_task_events(state)

    expect(chunks_of([...middle, ...closing])).toEqual([
      { parts: [text_part('one ')], append: false, last: false },
      { parts: [text_part('two ')], append: true, last: false },
      { parts: [text_part('three')], append: true, last: true },
    ])
  })

  it('addresses every chunk to the drive\'s task, context, and one artifact', () => {
    const state = create_a2a_mapper_state(IDS)
    const events = [...map_all(state, [text_chunk('write', 'a'), text_chunk('write', 'b')]), ...end_task_events(state)]
    expect(events).toHaveLength(2)
    for (const event of events) {
      expect(event).toMatchObject({
        kind: 'artifactUpdate',
        data: { taskId: 'task-1', contextId: 'ctx-1', artifact: { artifactId: 'art-1', name: '', extensions: [] } },
      })
    }
  })

  it('sends a lone chunk as a whole artifact once the drive ends', () => {
    const state = create_a2a_mapper_state(IDS)
    map_all(state, [text_chunk('write', 'only')])
    expect(chunks_of(end_task_events(state))).toEqual([{ parts: [text_part('only')], append: false, last: true }])
    expect(end_task_events(state)).toEqual([])
  })

  it('drops an empty text chunk', () => {
    const state = create_a2a_mapper_state(IDS)
    expect(map_all(state, [text_chunk('write', '')])).toEqual([])
    expect(has_streamed(state)).toBe(false)
  })
})

describe('to_task_events routing', () => {
  it('sends a call routed to none nowhere, and still streams the calls beside it', () => {
    const state = create_a2a_mapper_state({ ...IDS, stream: (id) => (id === 'plan' ? 'none' : 'artifact') })
    map_all(state, [text_chunk('plan', '{"steps":'), text_chunk('write', 'prose'), text_chunk('plan', '[]}')])
    expect(chunks_of(end_task_events(state))).toEqual([{ parts: [text_part('prose')], append: false, last: true }])
  })

  it('maps reasoning, tool calls, and finish chunks to nothing', () => {
    const state = create_a2a_mapper_state(IDS)
    const chunks = [
      { kind: 'reasoning', text: 'thinking', step_index: 0 },
      { kind: 'tool_call_start', id: 'c1', name: 'search', step_index: 0 },
      { kind: 'tool_call_end', id: 'c1', input: {}, step_index: 0 },
      { kind: 'tool_result', id: 'c1', output: 'found', step_index: 0 },
      { kind: 'finish', finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 1 } },
    ]
    const events = chunks.map((chunk): TrajectoryEvent => ({ kind: 'model_chunk', step_id: 'write', chunk }))
    expect(map_all(state, events)).toEqual([])
    expect(has_streamed(state)).toBe(false)
    expect(end_task_events(state)).toEqual([])
  })

  it('maps spans, emits, and malformed chunk events to nothing', () => {
    const state = create_a2a_mapper_state(IDS)
    const events: TrajectoryEvent[] = [
      { kind: 'span_start', span_id: 's1', name: 'step', id: 'write' },
      { kind: 'emit', text: 'not chat output' },
      { kind: 'cost', total_usd: 1 },
      { kind: 'model_chunk', chunk: { kind: 'text', text: 'no step id', step_index: 0 } },
      { kind: 'model_chunk', step_id: 'write', chunk: null },
      { kind: 'model_chunk', step_id: 'write', chunk: { kind: 'text', text: 7 } },
      { kind: 'run_end', status: 'done' },
    ]
    expect(map_all(state, events)).toEqual([])
    expect(has_streamed(state)).toBe(false)
  })
})

describe('to_task_events replays', () => {
  it('mutes a step that is replaying until its span ends, then lets it speak again', () => {
    const state = create_a2a_mapper_state(IDS)
    map_all(state, [
      { kind: 'step_replayed', step_id: 'draft', span_id: 's1', suspend_ids: ['approve'] },
      text_chunk('draft', 'said before'),
      text_chunk('other', 'new '),
      { kind: 'span_end', span_id: 's1', id: 'draft' },
      text_chunk('draft', 'said now'),
    ])
    expect(chunks_of(end_task_events(state))).toEqual([{ parts: [text_part('said now')], append: true, last: true }])
    expect(state.replaying.size).toBe(0)
  })

  it('keeps a step muted while any span that replays it is open', () => {
    const state = create_a2a_mapper_state(IDS)
    const events = map_all(state, [
      { kind: 'step_replayed', step_id: 'draft', span_id: 's1', suspend_ids: ['approve'] },
      { kind: 'step_replayed', step_id: 'draft', span_id: 's2', suspend_ids: ['approve'] },
      { kind: 'span_end', span_id: 's1', id: 'draft' },
      text_chunk('draft', 'still a replay'),
      { kind: 'span_end', span_id: 'unrelated' },
    ])
    expect(events).toEqual([])
    expect(end_task_events(state)).toEqual([])
    expect([...state.replaying]).toEqual([['s2', { step_id: 'draft', gates: new Set(['approve']) }]])
  })

  it('lets a step speak inside its span once the drive has passed every gate the replay named', () => {
    const state = create_a2a_mapper_state(IDS)
    const events = map_all(state, [
      { kind: 'step_replayed', step_id: 'ask', span_id: 's1', suspend_ids: ['ask_1', 'later'] },
      text_chunk('ask', 'round one again'),
      { kind: 'span_end', span_id: 'g1', id: 'ask_1' },
      text_chunk('ask', 'one gate is not all of them'),
      { kind: 'span_end', span_id: 'g2', id: 'later' },
      text_chunk('ask', 'round two'),
    ])
    expect(events).toEqual([])
    expect(state.replaying.size).toBe(0)
    expect(chunks_of(end_task_events(state))).toEqual([{ parts: [text_part('round two')], append: false, last: true }])
  })

  it('keeps a step muted past a gate that stopped the drive, and past a span that is no gate of its own', () => {
    const state = create_a2a_mapper_state(IDS)
    const events = map_all(state, [
      { kind: 'step_replayed', step_id: 'ask', span_id: 's1', suspend_ids: ['ask_1'] },
      { kind: 'span_end', span_id: 'g1', id: 'ask_1', error: 'suspended at ask_1' },
      { kind: 'span_end', span_id: 'g2', id: 'ask_send' },
      { kind: 'span_end', span_id: 'g3' },
      text_chunk('ask', 'still a replay'),
    ])
    expect(events).toEqual([])
    expect(end_task_events(state)).toEqual([])
    expect([...state.replaying.keys()]).toEqual(['s1'])
  })

  it('unmutes only the steps that waited on the gate that passed', () => {
    const state = create_a2a_mapper_state(IDS)
    map_all(state, [
      { kind: 'step_replayed', step_id: 'first', span_id: 's1', suspend_ids: ['a'] },
      { kind: 'step_replayed', step_id: 'second', span_id: 's2', suspend_ids: ['b'] },
      { kind: 'span_end', span_id: 'g1', id: 'a' },
      text_chunk('second', 'muted'),
      text_chunk('first', 'heard'),
    ])
    expect(chunks_of(end_task_events(state))).toEqual([{ parts: [text_part('heard')], append: false, last: true }])
    expect([...state.replaying.keys()]).toEqual(['s2'])
  })

  it('holds a replay that names no gates, or gates that are not strings, until its span ends', () => {
    const state = create_a2a_mapper_state(IDS)
    map_all(state, [
      { kind: 'step_replayed', step_id: 'draft', span_id: 's1' },
      { kind: 'step_replayed', step_id: 'other', span_id: 's2', suspend_ids: [7, 'approve'] },
      { kind: 'span_end', span_id: 'g1', id: 'anything' },
      text_chunk('draft', 'muted'),
      text_chunk('other', 'muted too'),
    ])
    expect(end_task_events(state)).toEqual([])
    expect(state.replaying.get('s2')).toEqual({ step_id: 'other', gates: new Set(['approve']) })
    map_all(state, [{ kind: 'span_end', span_id: 'g2', id: 'approve' }, text_chunk('other', 'heard')])
    expect([...state.replaying.keys()]).toEqual(['s1'])
    expect(chunks_of(end_task_events(state))).toEqual([{ parts: [text_part('heard')], append: false, last: true }])
  })

  it('ignores a step_replayed event that names no span or no step', () => {
    const state = create_a2a_mapper_state(IDS)
    map_all(state, [
      { kind: 'step_replayed', step_id: 'draft', suspend_ids: [] },
      { kind: 'step_replayed', span_id: 's1', suspend_ids: [] },
    ])
    expect(state.replaying.size).toBe(0)
  })
})

describe('end_task_events', () => {
  it('puts the output parts behind the last text chunk, in the same artifact', () => {
    const state = create_a2a_mapper_state(IDS)
    const before = map_all(state, [text_chunk('write', 'prose '), text_chunk('write', 'ends')])
    const closing = end_task_events(state, [data_part({ score: 3 })])
    expect(chunks_of([...before, ...closing])).toEqual([
      { parts: [text_part('prose ')], append: false, last: false },
      { parts: [text_part('ends'), data_part({ score: 3 })], append: true, last: true },
    ])
  })

  it('sends the output parts as the whole artifact when no text streamed', () => {
    const state = create_a2a_mapper_state(IDS)
    expect(chunks_of(end_task_events(state, [text_part('the output')]))).toEqual([
      { parts: [text_part('the output')], append: false, last: true },
    ])
  })

  it('sends nothing for a drive with no text and no output', () => {
    expect(end_task_events(create_a2a_mapper_state(IDS))).toEqual([])
    expect(end_task_events(create_a2a_mapper_state(IDS), [])).toEqual([])
  })
})

describe('has_streamed', () => {
  it('turns true with the first text chunk and stays true after the artifact closes', () => {
    const state = create_a2a_mapper_state(IDS)
    expect(has_streamed(state)).toBe(false)
    map_all(state, [text_chunk('write', 'a')])
    expect(has_streamed(state)).toBe(true)
    end_task_events(state)
    expect(has_streamed(state)).toBe(true)
  })
})
