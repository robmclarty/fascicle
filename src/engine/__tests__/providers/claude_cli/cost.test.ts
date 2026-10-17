/**
 * Per-turn cost allocation tests (spec §10, §12 #22, #24).
 *
 * Pure tests against allocate_cost_across_turns. decompose_total_cost's own
 * tests (§12 #23) live in pricing.test.ts beside it. Provider-reported
 * trajectory source verification lives in integration.test.ts.
 */

import { describe, expect, it } from 'vitest'
import { allocate_cost_across_turns } from '../../../providers/claude_cli/cost.js'

const EPS = 1e-9

describe('allocate_cost_across_turns', () => {
  it('§12 #24 — per-turn totals sum exactly to total_cost_usd', () => {
    const total = 0.0127
    const turns = [
      { output_tokens: 50, usage: { input_tokens: 200, output_tokens: 50 } },
      { output_tokens: 20, usage: { input_tokens: 50, output_tokens: 20 } },
      { output_tokens: 30, usage: { input_tokens: 80, output_tokens: 30 } },
    ]
    const per_turn = allocate_cost_across_turns(total, turns)
    const summed = per_turn.reduce((a, b) => a + b.total_usd, 0)
    expect(summed).toBe(total)
  })

  it('per-turn sum stays exact across fractional outputs (remainder absorbed by last turn)', () => {
    const total = 1 / 3
    const turns = [
      { output_tokens: 1, usage: { input_tokens: 0, output_tokens: 1 } },
      { output_tokens: 1, usage: { input_tokens: 0, output_tokens: 1 } },
      { output_tokens: 1, usage: { input_tokens: 0, output_tokens: 1 } },
    ]
    const per_turn = allocate_cost_across_turns(total, turns)
    const summed = per_turn.reduce((a, b) => a + b.total_usd, 0)
    expect(summed).toBe(total)
  })

  it('empty turns returns empty array', () => {
    expect(allocate_cost_across_turns(0.01, [])).toEqual([])
  })

  it('all-zero output_tokens splits cost evenly across turns', () => {
    const total = 0.06
    const turns = [
      { output_tokens: 0, usage: { input_tokens: 10, output_tokens: 0 } },
      { output_tokens: 0, usage: { input_tokens: 10, output_tokens: 0 } },
      { output_tokens: 0, usage: { input_tokens: 10, output_tokens: 0 } },
    ]
    const per_turn = allocate_cost_across_turns(total, turns)
    const summed = per_turn.reduce((a, b) => a + b.total_usd, 0)
    expect(Math.abs(summed - total)).toBeLessThan(EPS)
    expect(per_turn[0]?.total_usd).toBeCloseTo(total / 3, 9)
  })

  it('single turn receives the full cost', () => {
    const turns = [
      { output_tokens: 100, usage: { input_tokens: 500, output_tokens: 100 } },
    ]
    const per_turn = allocate_cost_across_turns(0.5, turns)
    expect(per_turn).toHaveLength(1)
    expect(per_turn[0]?.total_usd).toBe(0.5)
  })

  it('weights larger turns higher than smaller turns', () => {
    const turns = [
      { output_tokens: 10, usage: { input_tokens: 10, output_tokens: 10 } },
      { output_tokens: 90, usage: { input_tokens: 10, output_tokens: 90 } },
    ]
    const per_turn = allocate_cost_across_turns(1, turns)
    expect(per_turn[0]?.total_usd).toBeLessThan(per_turn[1]?.total_usd ?? 0)
  })
})
