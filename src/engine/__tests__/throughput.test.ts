/**
 * throughput(): the derived tokens-per-second view over StepTiming.
 *
 * Pure-function tests over hand-built step records: the decode vs blended
 * basis rules, the skip of unmeasured steps, the three accepted source
 * shapes, and the undefined cases where a rate would divide by zero.
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
