/**
 * Cost decomposition + per-turn allocation tests (spec §10, §12 #22, #23, #24).
 *
 * Pure tests against decompose_total_cost + allocate_cost_across_turns.
 * Provider-reported trajectory source verification lives in integration.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  allocate_cost_across_turns,
  decompose_total_cost,
} from '../../../src/providers/claude_cli/cost.js';
import type { UsageTotals } from '../../../src/types.js';

const EPS = 1e-9;

describe('decompose_total_cost — component sum', () => {
  it('§12 #23 — input_usd + output_usd ≈ total_usd within 1e-9 (no cache tokens)', () => {
    const cost = decompose_total_cost(0.0127, { input_tokens: 1000, output_tokens: 200 });
    expect(cost.total_usd).toBe(0.0127);
    expect(cost.currency).toBe('USD');
    expect(cost.is_estimate).toBe(true);
    const sum =
      cost.input_usd +
      cost.output_usd +
      (cost.cached_input_usd ?? 0) +
      (cost.cache_write_usd ?? 0);
    expect(Math.abs(sum - cost.total_usd)).toBeLessThan(EPS);
  });

  it('§12 #23 — component sum holds with cache_read and cache_write tokens', () => {
    const usage: UsageTotals = {
      input_tokens: 500,
      output_tokens: 100,
      cached_input_tokens: 300,
      cache_write_tokens: 100,
    };
    const cost = decompose_total_cost(0.0234, usage);
    const sum =
      cost.input_usd +
      cost.output_usd +
      (cost.cached_input_usd ?? 0) +
      (cost.cache_write_usd ?? 0);
    expect(Math.abs(sum - 0.0234)).toBeLessThan(EPS);
    expect(cost.cached_input_usd).toBeGreaterThan(0);
    expect(cost.cache_write_usd).toBeGreaterThan(0);
  });

  it('component sum holds across many synthetic fixtures (property-style)', () => {
    const fixtures: Array<{ total: number; usage: UsageTotals }> = [
      { total: 0.0001, usage: { input_tokens: 10, output_tokens: 1 } },
      { total: 1.5, usage: { input_tokens: 99999, output_tokens: 33333 } },
      {
        total: 0.05,
        usage: {
          input_tokens: 1000,
          output_tokens: 250,
          cached_input_tokens: 400,
        },
      },
      {
        total: 0.125,
        usage: {
          input_tokens: 2000,
          output_tokens: 500,
          cache_write_tokens: 200,
        },
      },
      {
        total: 7.89,
        usage: {
          input_tokens: 10_000,
          output_tokens: 2_000,
          cached_input_tokens: 3_000,
          cache_write_tokens: 1_000,
        },
      },
    ];
    for (const { total, usage } of fixtures) {
      const cost = decompose_total_cost(total, usage);
      const sum =
        cost.input_usd +
        cost.output_usd +
        (cost.cached_input_usd ?? 0) +
        (cost.cache_write_usd ?? 0);
      expect(Math.abs(sum - total)).toBeLessThan(EPS);
    }
  });

  it('is_estimate is always true for claude_cli-sourced costs', () => {
    const c = decompose_total_cost(0.01, { input_tokens: 100, output_tokens: 20 });
    expect(c.is_estimate).toBe(true);
  });

  it('omits cached_input_usd when cached_input_tokens is zero', () => {
    const c = decompose_total_cost(0.01, { input_tokens: 100, output_tokens: 20 });
    expect(c.cached_input_usd).toBeUndefined();
    expect(c.cache_write_usd).toBeUndefined();
  });

  it('total=0 returns zero breakdown without division by zero', () => {
    const c = decompose_total_cost(0, { input_tokens: 100, output_tokens: 20 });
    expect(c.total_usd).toBe(0);
    expect(c.input_usd).toBe(0);
    expect(c.output_usd).toBe(0);
  });

  it('all zero tokens with nonzero total returns zero components', () => {
    const c = decompose_total_cost(0.01, { input_tokens: 0, output_tokens: 0 });
    expect(c.total_usd).toBe(0.01);
    expect(c.input_usd).toBe(0);
    expect(c.output_usd).toBe(0);
  });

  it('negative token counts are clamped to zero', () => {
    const c = decompose_total_cost(0.01, {
      input_tokens: -10 as unknown as number,
      output_tokens: 100,
    });
    expect(c.input_usd).toBe(0);
    expect(c.output_usd).toBe(0.01);
  });
});

describe('allocate_cost_across_turns', () => {
  it('§12 #24 — per-turn totals sum exactly to total_cost_usd', () => {
    const total = 0.0127;
    const turns = [
      { output_tokens: 50, usage: { input_tokens: 200, output_tokens: 50 } },
      { output_tokens: 20, usage: { input_tokens: 50, output_tokens: 20 } },
      { output_tokens: 30, usage: { input_tokens: 80, output_tokens: 30 } },
    ];
    const per_turn = allocate_cost_across_turns(total, turns);
    const summed = per_turn.reduce((a, b) => a + b.total_usd, 0);
    expect(summed).toBe(total);
  });

  it('per-turn sum stays exact across fractional outputs (remainder absorbed by last turn)', () => {
    const total = 1 / 3;
    const turns = [
      { output_tokens: 1, usage: { input_tokens: 0, output_tokens: 1 } },
      { output_tokens: 1, usage: { input_tokens: 0, output_tokens: 1 } },
      { output_tokens: 1, usage: { input_tokens: 0, output_tokens: 1 } },
    ];
    const per_turn = allocate_cost_across_turns(total, turns);
    const summed = per_turn.reduce((a, b) => a + b.total_usd, 0);
    expect(summed).toBe(total);
  });

  it('empty turns returns empty array', () => {
    expect(allocate_cost_across_turns(0.01, [])).toEqual([]);
  });

  it('all-zero output_tokens splits cost evenly across turns', () => {
    const total = 0.06;
    const turns = [
      { output_tokens: 0, usage: { input_tokens: 10, output_tokens: 0 } },
      { output_tokens: 0, usage: { input_tokens: 10, output_tokens: 0 } },
      { output_tokens: 0, usage: { input_tokens: 10, output_tokens: 0 } },
    ];
    const per_turn = allocate_cost_across_turns(total, turns);
    const summed = per_turn.reduce((a, b) => a + b.total_usd, 0);
    expect(Math.abs(summed - total)).toBeLessThan(EPS);
    expect(per_turn[0]?.total_usd).toBeCloseTo(total / 3, 9);
  });

  it('single turn receives the full cost', () => {
    const turns = [
      { output_tokens: 100, usage: { input_tokens: 500, output_tokens: 100 } },
    ];
    const per_turn = allocate_cost_across_turns(0.5, turns);
    expect(per_turn).toHaveLength(1);
    expect(per_turn[0]?.total_usd).toBe(0.5);
  });

  it('weights larger turns higher than smaller turns', () => {
    const turns = [
      { output_tokens: 10, usage: { input_tokens: 10, output_tokens: 10 } },
      { output_tokens: 90, usage: { input_tokens: 10, output_tokens: 90 } },
    ];
    const per_turn = allocate_cost_across_turns(1, turns);
    expect(per_turn[0]?.total_usd).toBeLessThan(per_turn[1]?.total_usd ?? 0);
  });
});
