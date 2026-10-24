/**
 * The first-chunk stamp both transports keep for a turn attempt: when the
 * first chunk went out, and whether it belonged to a tool call that arrived
 * whole. Driven chunk by chunk with Date faked, so each stamp is exact.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create_first_chunk_stamp, type FirstChunkStamp } from '../first_chunk_stamp.js'
import type { StreamChunk } from '../types.js'

const T0 = 1_700_000_000_000

const start = (id: string): StreamChunk => ({ kind: 'tool_call_start', id, name: 'save', step_index: 0 })
const delta = (id: string, text = '{}'): StreamChunk => ({
  kind: 'tool_call_input_delta',
  id,
  delta: text,
  step_index: 0,
})
const end = (id: string): StreamChunk => ({ kind: 'tool_call_end', id, input: {}, step_index: 0 })
const text: StreamChunk = { kind: 'text', text: 'a', step_index: 0 }
const reasoning: StreamChunk = { kind: 'reasoning', text: 'hmm', step_index: 0 }

function observe_all(chunks: readonly StreamChunk[]): FirstChunkStamp {
  const stamp = create_first_chunk_stamp()
  for (const chunk of chunks) stamp.observe(chunk)
  return stamp
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the first-chunk stamp', () => {
  it('holds nothing before a chunk', () => {
    const stamp = create_first_chunk_stamp()
    expect(stamp.at()).toBeUndefined()
    expect(stamp.whole_tool_call()).toBe(false)
  })

  it('stamps the first chunk and keeps that stamp through later ones', () => {
    const stamp = create_first_chunk_stamp()
    vi.setSystemTime(T0 + 40)
    stamp.observe(text)
    vi.setSystemTime(T0 + 90)
    stamp.observe(text)
    expect(stamp.at()).toBe(T0 + 40)
  })

  it('clears the stamp and the mark on reset', () => {
    const stamp = observe_all([end('c1')])
    expect(stamp.whole_tool_call()).toBe(true)
    stamp.reset()
    expect(stamp.at()).toBeUndefined()
    expect(stamp.whole_tool_call()).toBe(false)
    vi.setSystemTime(T0 + 7)
    stamp.observe(text)
    expect(stamp.at()).toBe(T0 + 7)
    expect(stamp.whole_tool_call()).toBe(false)
  })

  it('forgets a half-watched call on reset', () => {
    const stamp = observe_all([start('c1'), delta('c1')])
    stamp.reset()
    stamp.observe(text)
    stamp.observe(end('c1'))
    expect(stamp.whole_tool_call()).toBe(false)
  })

  it('forgets the deltas a failed attempt counted on reset', () => {
    const stamp = observe_all([start('c1'), delta('c1'), delta('c1')])
    stamp.reset()
    for (const chunk of [start('c1'), delta('c1'), end('c1')]) stamp.observe(chunk)
    expect(stamp.whole_tool_call()).toBe(true)
  })
})

describe('a tool call that arrived whole', () => {
  it.each([
    ['a lone end, as the AI SDK reports an Ollama call', [end('c1')]],
    ['a start then its end, as native Ollama sends one', [start('c1'), end('c1')]],
    ['a start, one delta, and its end, as a whole OpenAI-compatible call', [start('c1'), delta('c1'), end('c1')]],
    [
      'a whole call beside a second call that streamed',
      [start('c1'), delta('c1'), start('c2'), delta('c2'), delta('c2'), end('c1'), end('c2')],
    ],
  ])('is marked: %s', (_name, chunks) => {
    expect(observe_all(chunks).whole_tool_call()).toBe(true)
  })

  it('is not marked until its end arrives', () => {
    expect(observe_all([start('c1'), delta('c1')]).whole_tool_call()).toBe(false)
  })
})

describe('a first chunk that streamed', () => {
  it.each([
    ['text', [text, start('c1'), end('c1')]],
    ['reasoning', [reasoning, end('c1')]],
    ['an input delta whose start never came', [delta('c1'), end('c1')]],
    ['a call whose input came in two deltas', [start('c1'), delta('c1', ''), delta('c1'), end('c1')]],
    ['a call whose input came in many deltas', [start('c1'), delta('c1'), delta('c1'), delta('c1'), end('c1')]],
    [
      "a call whose own deltas streamed, whatever another call's did",
      [start('c1'), delta('c1'), start('c2'), end('c2'), delta('c1'), end('c1')],
    ],
  ])('is not marked: %s', (_name, chunks) => {
    expect(observe_all(chunks).whole_tool_call()).toBe(false)
  })

  it('stops watching once its call has ended', () => {
    // A second call that arrives whole later doesn't change what the first
    // chunk was.
    const stamp = observe_all([start('c1'), delta('c1'), delta('c1'), end('c1'), start('c2'), end('c2')])
    expect(stamp.whole_tool_call()).toBe(false)
  })
})
