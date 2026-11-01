import { describe, expect, it } from 'vitest'
import type { TrajectoryEvent } from '#core'
import type { FinishReason, StreamChunk } from '#engine'
import { create_session_usage, finish_reason_of, note_usage, stop_reason_for, usage_update } from '../usage.js'

function model_chunk(chunk: unknown): TrajectoryEvent {
  return { kind: 'model_chunk', step_id: 'm', chunk }
}

function step_finish(input_tokens: number, output_tokens: number): TrajectoryEvent {
  const chunk: StreamChunk = {
    kind: 'step_finish',
    step_index: 0,
    finish_reason: 'stop',
    usage: { input_tokens, output_tokens },
  }
  return model_chunk(chunk)
}

function finish(finish_reason: FinishReason): TrajectoryEvent {
  const chunk: StreamChunk = { kind: 'finish', finish_reason, usage: { input_tokens: 1, output_tokens: 1 } }
  return model_chunk(chunk)
}

describe('usage: note_usage', () => {
  it('starts a session with nothing spent and no cost', () => {
    expect(create_session_usage()).toEqual({ context_tokens: 0, cost_usd: 0, priced: false })
  })

  it("takes the context from the last model turn's input and output, not their sum across turns", () => {
    const usage = create_session_usage()
    expect(note_usage(usage, step_finish(1000, 200))).toBe(true)
    expect(note_usage(usage, step_finish(1300, 50))).toBe(true)
    expect(usage.context_tokens).toBe(1350)
  })

  it("reads a tool loop's response_received the same way, and says nothing changed when a turn is reported twice", () => {
    const usage = create_session_usage()
    expect(note_usage(usage, { kind: 'response_received', input_tokens: 500, output_tokens: 20 })).toBe(true)
    expect(note_usage(usage, step_finish(500, 20))).toBe(false)
    expect(usage.context_tokens).toBe(520)
  })

  it('ignores a response_received that carries no token counts', () => {
    const usage = create_session_usage()
    expect(note_usage(usage, { kind: 'response_received', input_tokens: 500 })).toBe(false)
    expect(note_usage(usage, { kind: 'response_received', output_tokens: 20 })).toBe(false)
    expect(usage.context_tokens).toBe(0)
  })

  it('adds up the cost of every priced turn and marks the session priced', () => {
    const usage = create_session_usage()
    expect(note_usage(usage, { kind: 'cost', total_usd: 0.25 })).toBe(true)
    expect(note_usage(usage, { kind: 'cost', total_usd: 0.5 })).toBe(true)
    expect(usage).toEqual({ context_tokens: 0, cost_usd: 0.75, priced: true })
  })

  it('ignores a cost event that carries no total', () => {
    const usage = create_session_usage()
    expect(note_usage(usage, { kind: 'cost', total_usd: 'a lot' })).toBe(false)
    expect(usage.priced).toBe(false)
  })

  it.each<[string, TrajectoryEvent]>([
    ['a finish chunk', finish('stop')],
    ['a text chunk', model_chunk({ kind: 'text', text: 'hi', step_index: 0 })],
    ['a model_chunk with no chunk', model_chunk(null)],
    ['a span', { kind: 'span_start', id: 'm', name: 'model_call' }],
  ])('leaves the usage alone for %s', (_, event) => {
    const usage = create_session_usage()
    expect(note_usage(usage, event)).toBe(false)
    expect(usage).toEqual(create_session_usage())
  })
})

describe('usage: usage_update', () => {
  it('reports the context against the window, with no cost before a turn is priced', () => {
    const usage = create_session_usage()
    note_usage(usage, step_finish(900, 100))
    expect(usage_update(usage, 200_000)).toEqual({ sessionUpdate: 'usage_update', used: 1000, size: 200_000 })
  })

  it('reports the cost in US dollars once a turn is priced', () => {
    const usage = create_session_usage()
    note_usage(usage, { kind: 'cost', total_usd: 0.125 })
    expect(usage_update(usage, 8000)).toEqual({
      sessionUpdate: 'usage_update',
      used: 0,
      size: 8000,
      cost: { amount: 0.125, currency: 'USD' },
    })
  })
})

describe('usage: stop reasons', () => {
  it("reads the finish reason off a finish chunk, and nothing off a step's finish", () => {
    expect(finish_reason_of(finish('max_steps'))).toBe('max_steps')
    expect(finish_reason_of(step_finish(1, 1))).toBeUndefined()
    expect(finish_reason_of({ kind: 'emit', finish_reason: 'stop' })).toBeUndefined()
  })

  it.each<[FinishReason | undefined, string]>([
    ['max_steps', 'max_turn_requests'],
    ['length', 'max_tokens'],
    ['content_filter', 'refusal'],
    ['stop', 'end_turn'],
    ['tool_calls', 'end_turn'],
    [undefined, 'end_turn'],
  ])('answers a turn whose last model call finished with %s as %s', (reason, expected) => {
    expect(stop_reason_for(reason)).toBe(expected)
  })
})
