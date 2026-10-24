/**
 * throughput(): the derived tokens-per-second view over StepTiming.
 *
 * Pure-function tests over hand-built step records: the decode vs blended
 * basis rules, a whole tool call's round trip counting as blended, the decode
 * time Ollama reports winning over the engine's own timing, the skip of unmeasured steps, the three accepted source shapes, and
 * the undefined cases where a rate would divide by zero.
 */

import { describe, expect, it } from 'vitest'
import { throughput } from '../throughput.js'
import type { GenerateResult, StepRecord, StepTiming } from '../types.js'

function make_step(
  output_tokens: number,
  timing: StepTiming | undefined,
  index = 0,
): StepRecord {
  const step: StepRecord = {
    index,
    text: '',
    tool_calls: [],
    usage: { input_tokens: 10, output_tokens },
    finish_reason: 'stop',
  }
  if (timing !== undefined) step.timing = timing
  return step
}

/** A step whose provider reported `ollama` beside the engine's timing, as Ollama's steps do. */
function ollama_step(
  output_tokens: number,
  timing: StepTiming | undefined,
  ollama: unknown,
  index = 0,
): StepRecord {
  return { ...make_step(output_tokens, timing, index), provider_reported: { ollama } }
}

function make_result(steps: StepRecord[]): GenerateResult {
  return {
    content: '',
    tool_calls: [],
    steps,
    usage: { input_tokens: 10, output_tokens: 100 },
    finish_reason: 'stop',
    model_resolved: { provider: 'p', model_id: 'm' },
  }
}

describe('throughput', () => {
  it('computes a blended rate from a non-streamed step', () => {
    const step = make_step(100, { started_at: 0, duration_ms: 2000 })
    expect(throughput(step)).toEqual({
      tokens_per_second: 50,
      basis: 'blended',
      output_tokens: 100,
      measured_ms: 2000,
    })
  })

  it('computes a decode rate from a streamed step, excluding time to first chunk', () => {
    const step = make_step(100, { started_at: 0, duration_ms: 2100, first_chunk_ms: 100 })
    expect(throughput(step)).toEqual({
      tokens_per_second: 50,
      basis: 'decode',
      output_tokens: 100,
      measured_ms: 2000,
    })
  })

  it('sums steps and downgrades the basis when any window is blended', () => {
    const streamed = make_step(30, { started_at: 0, duration_ms: 1200, first_chunk_ms: 200 })
    const plain = make_step(20, { started_at: 0, duration_ms: 1000 }, 1)
    expect(throughput([streamed, plain])).toEqual({
      tokens_per_second: 25,
      basis: 'blended',
      output_tokens: 50,
      measured_ms: 2000,
    })
  })

  it('keeps the decode basis when every step streamed', () => {
    const a = make_step(10, { started_at: 0, duration_ms: 600, first_chunk_ms: 100 })
    const b = make_step(20, { started_at: 0, duration_ms: 700, first_chunk_ms: 200 }, 1)
    expect(throughput([a, b])).toEqual({
      tokens_per_second: 30,
      basis: 'decode',
      output_tokens: 30,
      measured_ms: 1000,
    })
  })

  it('excludes steps without timing from both token and time sums', () => {
    const timed = make_step(40, { started_at: 0, duration_ms: 1000 })
    const untimed = make_step(999, undefined, 1)
    expect(throughput([timed, untimed])).toEqual({
      tokens_per_second: 40,
      basis: 'blended',
      output_tokens: 40,
      measured_ms: 1000,
    })
  })

  it('accepts a whole GenerateResult', () => {
    const result = make_result([make_step(100, { started_at: 0, duration_ms: 2000 })])
    expect(throughput(result)?.tokens_per_second).toBe(50)
  })

  it('returns undefined when no step carries timing', () => {
    expect(throughput([])).toBeUndefined()
    expect(throughput([make_step(50, undefined)])).toBeUndefined()
    expect(throughput(make_result([make_step(50, undefined)]))).toBeUndefined()
  })

  it('returns undefined when the measured window is zero', () => {
    expect(throughput(make_step(50, { started_at: 0, duration_ms: 0 }))).toBeUndefined()
    expect(
      throughput(make_step(50, { started_at: 0, duration_ms: 100, first_chunk_ms: 100 })),
    ).toBeUndefined()
  })
})

describe('throughput on a step whose first chunk was a whole tool call', () => {
  it('counts the round trip as blended, not the last few milliseconds as decode', () => {
    const step = make_step(180, {
      started_at: 0,
      duration_ms: 6000,
      first_chunk_ms: 5997,
      whole_tool_call: true,
    })
    expect(throughput(step)).toEqual({
      tokens_per_second: 30,
      basis: 'blended',
      output_tokens: 180,
      measured_ms: 6000,
    })
  })

  it('downgrades the basis of a call whose other steps streamed', () => {
    const streamed = make_step(30, { started_at: 0, duration_ms: 1200, first_chunk_ms: 200 })
    const whole = make_step(
      20,
      { started_at: 0, duration_ms: 1000, first_chunk_ms: 995, whole_tool_call: true },
      1,
    )
    expect(throughput([streamed, whole])).toEqual({
      tokens_per_second: 25,
      basis: 'blended',
      output_tokens: 50,
      measured_ms: 2000,
    })
  })

  it("takes Ollama's reported decode time over the mark", () => {
    const step = ollama_step(
      180,
      { started_at: 0, duration_ms: 5477, first_chunk_ms: 5474, whole_tool_call: true },
      { eval_duration: 4_800_000_000 },
    )
    expect(throughput(step)).toEqual({
      tokens_per_second: 37.5,
      basis: 'decode',
      output_tokens: 180,
      measured_ms: 4800,
    })
  })
})

describe('throughput on a step that reports its own decode time', () => {
  it("takes the daemon's window over a first chunk that arrived as the turn ended", () => {
    // The issue's tool-call turn: the call came whole, 3ms before the end, so
    // the streamed window would read 60,000 tokens a second.
    const step = ollama_step(
      180,
      { started_at: 0, duration_ms: 5477, first_chunk_ms: 5474 },
      // The ai_sdk shape, which carries strings beside the durations.
      {
        model: 'qwen3:4b',
        created_at: '2026-10-09T00:00:00.000Z',
        total_duration: 5_470_000_000,
        eval_duration: 4_800_000_000,
      },
    )
    expect(throughput(step)).toEqual({
      tokens_per_second: 37.5,
      basis: 'decode',
      output_tokens: 180,
      measured_ms: 4800,
    })
  })

  it('counts an unstreamed step as decode, since the daemon timed the decode itself', () => {
    const step = ollama_step(100, { started_at: 0, duration_ms: 6000 }, { eval_duration: 4_000_000_000 })
    expect(throughput(step)).toEqual({
      tokens_per_second: 25,
      basis: 'decode',
      output_tokens: 100,
      measured_ms: 4000,
    })
  })

  it('counts a reported window on a step that carries no timing', () => {
    const step = ollama_step(40, undefined, { eval_duration: 2_000_000_000 })
    expect(throughput(step)).toEqual({
      tokens_per_second: 20,
      basis: 'decode',
      output_tokens: 40,
      measured_ms: 2000,
    })
  })

  it('sums a reported window with a blended one and downgrades the basis', () => {
    const reported = ollama_step(
      30,
      { started_at: 0, duration_ms: 1500, first_chunk_ms: 1499 },
      { eval_duration: 1_000_000_000 },
    )
    const plain = make_step(20, { started_at: 0, duration_ms: 1000 }, 1)
    expect(throughput([reported, plain])).toEqual({
      tokens_per_second: 25,
      basis: 'blended',
      output_tokens: 50,
      measured_ms: 2000,
    })
  })

  it.each([
    ['no ollama entry', undefined],
    ['a null entry', null],
    ['an entry that is not an object', '4800000000'],
    ['no eval_duration', { total_duration: 4_800_000_000 }],
    ['a zero eval_duration', { eval_duration: 0 }],
    ['a negative eval_duration', { eval_duration: -4_800_000_000 }],
    ['an eval_duration that is a string', { eval_duration: '4800000000' }],
  ])("falls back to the step's timing given %s", (_name, ollama) => {
    const step = ollama_step(100, { started_at: 0, duration_ms: 2100, first_chunk_ms: 100 }, ollama)
    expect(throughput(step)).toEqual({
      tokens_per_second: 50,
      basis: 'decode',
      output_tokens: 100,
      measured_ms: 2000,
    })
  })

  it("reads no other provider's entry", () => {
    const step: StepRecord = {
      ...make_step(100, { started_at: 0, duration_ms: 2000 }),
      provider_reported: { openai: { eval_duration: 4_000_000_000 } },
    }
    expect(throughput(step)).toEqual({
      tokens_per_second: 50,
      basis: 'blended',
      output_tokens: 100,
      measured_ms: 2000,
    })
  })
})
