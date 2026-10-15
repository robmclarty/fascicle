import { describe, expect, it } from 'vitest'
import { loop, retry, run, step } from '#core'
import type { Step, TrajectoryEvent } from '#core'
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
      { sessionUpdate: 'tool_call', toolCallId: 't1:m:0:c1', title: 'lookup', kind: 'other', status: 'pending' },
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
      { sessionUpdate: 'tool_call_update', toolCallId: 't1:m:0:c1', status: 'in_progress', rawInput: { q: 'x' } },
    ])
  })

  it('completes the card with the raw output', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    const updates = to_session_updates(
      model_chunk({ kind: 'tool_result', id: 'c1', output: { hits: 2 }, step_index: 0 }),
      state,
    )
    expect(updates).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 't1:m:0:c1', status: 'completed', rawOutput: { hits: 2 } },
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
        toolCallId: 't1:m:0:c1',
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
    expect(id_of(start('first'), state)).toBe('t1:first:0:ollama_call_0_0')
    expect(id_of(start('second'), state)).toBe('t1:second:0:ollama_call_0_0')
  })

  it('keeps two turns that report the same raw id apart', () => {
    const one = create_acp_mapper_state({ turn_id: 't1' })
    const two = create_acp_mapper_state({ turn_id: 't2' })
    expect(id_of(start('m'), one)).toBe('t1:m:0:ollama_call_0_0')
    expect(id_of(start('m'), two)).toBe('t2:m:0:ollama_call_0_0')
  })

  it('gives each turn a fresh random id when none is passed', () => {
    const one = id_of(start('m'), create_acp_mapper_state())
    const two = id_of(start('m'), create_acp_mapper_state())
    expect(one).toMatch(/^[0-9a-f-]{36}:m:0:ollama_call_0_0$/)
    expect(two).toMatch(/^[0-9a-f-]{36}:m:0:ollama_call_0_0$/)
    expect(one).not.toBe(two)
  })

  it('carries the same id from start through end to result', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    const ids = [
      id_of(model_chunk({ kind: 'tool_call_start', id: 'c1', name: 'lookup', step_index: 0 }), state),
      id_of(model_chunk({ kind: 'tool_call_end', id: 'c1', input: {}, step_index: 0 }), state),
      id_of(model_chunk({ kind: 'tool_result', id: 'c1', output: 'ok', step_index: 0 }), state),
    ]
    expect(ids).toEqual(['t1:m:0:c1', 't1:m:0:c1', 't1:m:0:c1'])
  })

  it('carries how many times the step has started', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    to_session_updates({ kind: 'span_start', span_id: 's1', name: 'm', id: 'm' }, state)
    expect(id_of(start('m'), state)).toBe('t1:m:1:ollama_call_0_0')
    to_session_updates({ kind: 'span_start', span_id: 's2', name: 'm', id: 'm' }, state)
    expect(id_of(start('m'), state)).toBe('t1:m:2:ollama_call_0_0')
  })
})

describe('to_session_updates: run counts', () => {
  it('starts each turn with no runs counted', () => {
    expect(create_acp_mapper_state({ turn_id: 't1' }).runs).toEqual(new Map())
  })

  it('counts each span start by the id it carries', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    for (const id of ['m', 'other', 'm']) {
      expect(to_session_updates({ kind: 'span_start', span_id: `${id}:1`, name: id, id }, state)).toEqual([])
    }
    expect(state.runs).toEqual(
      new Map([
        ['m', 2],
        ['other', 1],
      ]),
    )
  })

  it.each<[string, TrajectoryEvent]>([
    ['a span start with no id', { kind: 'span_start', span_id: 's1', name: 'engine.generate' }],
    ['a span start whose id is not a string', { kind: 'span_start', span_id: 's1', name: 'x', id: 7 }],
    ['a span end', { kind: 'span_end', span_id: 's1', id: 'm' }],
    ['a model chunk', model_chunk({ kind: 'tool_call_start', id: 'c1', name: 'lookup', step_index: 0 })],
  ])('counts nothing for %s', (_name, event) => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    to_session_updates(event, state)
    expect(state.runs).toEqual(new Map())
  })
})

describe('to_session_updates: a model call that runs again', () => {
  /**
   * Stand in for a model_call on Ollama: a step that records model_chunk
   * events under its own id and numbers its one tool call afresh each run.
   * `fail` throws on the first run, before or after the finish chunk.
   */
  function ollama_call(fail?: 'before_finish' | 'after_finish'): Step<number, number> {
    let runs = 0
    return step('lookup_call', async (n: number, ctx) => {
      runs += 1
      const record = (chunk: StreamChunk): void => {
        ctx.trajectory.record({ kind: 'model_chunk', step_id: 'lookup_call', chunk })
      }
      record({ kind: 'tool_call_start', id: 'ollama_call_0_0', name: 'lookup', step_index: 0 })
      if (fail === 'before_finish' && runs === 1) throw new Error('connection reset')
      record({ kind: 'tool_result', id: 'ollama_call_0_0', output: runs, step_index: 0 })
      record({ kind: 'finish', finish_reason: 'stop', usage })
      if (fail === 'after_finish' && runs === 1) throw new Error('schema mismatch')
      return n + 1
    })
  }

  /** Run a flow through `run.stream` and list each tool update's kind and id, in order. */
  async function tool_updates(flow: Step<number, number>): Promise<string[]> {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    const handle = run.stream(flow, 0)
    const seen: string[] = []
    for await (const event of handle.events) {
      for (const update of to_session_updates(event, state)) {
        seen.push(`${update.sessionUpdate} ${String(Reflect.get(update, 'toolCallId'))}`)
      }
    }
    await handle.result
    return seen
  }

  it('opens a card for each round of a loop', async () => {
    const flow = loop({ init: (n: number) => n, body: ollama_call(), finish: (n) => n, max_rounds: 2 })
    expect(await tool_updates(flow)).toEqual([
      'tool_call t1:lookup_call:1:ollama_call_0_0',
      'tool_call_update t1:lookup_call:1:ollama_call_0_0',
      'tool_call t1:lookup_call:2:ollama_call_0_0',
      'tool_call_update t1:lookup_call:2:ollama_call_0_0',
    ])
  })

  it('opens a card for each attempt of a retry', async () => {
    const flow = retry(ollama_call('after_finish'), { max_attempts: 2, backoff_ms: 0 })
    expect(await tool_updates(flow)).toEqual([
      'tool_call t1:lookup_call:1:ollama_call_0_0',
      'tool_call_update t1:lookup_call:1:ollama_call_0_0',
      'tool_call t1:lookup_call:2:ollama_call_0_0',
      'tool_call_update t1:lookup_call:2:ollama_call_0_0',
    ])
  })

  it('opens a new card when the first attempt failed before it finished', async () => {
    const flow = retry(ollama_call('before_finish'), { max_attempts: 2, backoff_ms: 0 })
    expect(await tool_updates(flow)).toEqual([
      'tool_call t1:lookup_call:1:ollama_call_0_0',
      'tool_call t1:lookup_call:2:ollama_call_0_0',
      'tool_call_update t1:lookup_call:2:ollama_call_0_0',
    ])
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

describe('to_session_updates: repeated events', () => {
  it('maps the same model chunk the same way every time', () => {
    const state = create_acp_mapper_state({ turn_id: 't1' })
    const event = model_chunk({ kind: 'tool_call_start', id: 'c1', name: 'lookup', step_index: 0 })
    expect(to_session_updates(event, state)).toEqual(to_session_updates(event, state))
    expect(state.turn_id).toBe('t1')
  })
})
