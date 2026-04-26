/**
 * Cost decomposition from CLI-reported total_cost_usd (spec §10).
 *
 * The CLI reports a single total_cost_usd and per-turn usage; it does not
 * break cost down by component or by turn. The adapter synthesizes a
 * component split by computing an implied per-million rate from the total
 * and allocating that rate to each token component, weighted by
 * CACHE_READ_MULTIPLIER and CACHE_WRITE_MULTIPLIER.
 *
 * Per-turn allocation splits total_cost_usd across turns proportional to
 * each turn's output_tokens. Sum equality is preserved exactly by giving any
 * floating-point rounding remainder to the last turn.
 */

import type { CostBreakdown, UsageTotals } from '../../types.js';
import { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER } from './constants.js';

export function decompose_total_cost(
  total_cost_usd: number,
  usage: UsageTotals,
): CostBreakdown {
  const input = Math.max(0, usage.input_tokens);
  const output = Math.max(0, usage.output_tokens);
  const cached = Math.max(0, usage.cached_input_tokens ?? 0);
  const cache_write = Math.max(0, usage.cache_write_tokens ?? 0);

  const base_input = Math.max(0, input - cached - cache_write);

  const input_weight = base_input;
  const output_weight = output;
  const cached_weight = cached * CACHE_READ_MULTIPLIER;
  const cache_write_weight = cache_write * CACHE_WRITE_MULTIPLIER;

  const total_weight = input_weight + output_weight + cached_weight + cache_write_weight;

  if (total_weight === 0 || total_cost_usd === 0) {
    return {
      total_usd: total_cost_usd,
      input_usd: 0,
      output_usd: 0,
      currency: 'USD',
      is_estimate: true,
    };
  }

  const input_usd = (total_cost_usd * input_weight) / total_weight;
  const output_usd = (total_cost_usd * output_weight) / total_weight;
  const cached_usd_raw = (total_cost_usd * cached_weight) / total_weight;
  const cache_write_usd_raw = (total_cost_usd * cache_write_weight) / total_weight;

  const breakdown: CostBreakdown = {
    total_usd: total_cost_usd,
    input_usd,
    output_usd,
    currency: 'USD',
    is_estimate: true,
  };
  if (cached > 0) breakdown.cached_input_usd = cached_usd_raw;
  if (cache_write > 0) breakdown.cache_write_usd = cache_write_usd_raw;
  return breakdown;
}

export type TurnUsage = {
  readonly output_tokens: number;
  readonly usage: UsageTotals;
};

export function allocate_cost_across_turns(
  total_cost_usd: number,
  turns: ReadonlyArray<TurnUsage>,
): ReadonlyArray<CostBreakdown> {
  if (turns.length === 0) return [];

  const total_output = turns.reduce((sum, t) => sum + Math.max(0, t.output_tokens), 0);

  const per_turn_totals: number[] = Array.from({ length: turns.length }, () => 0);
  if (total_output === 0) {
    const equal_share = total_cost_usd / turns.length;
    for (let i = 0; i < turns.length; i += 1) per_turn_totals[i] = equal_share;
  } else {
    for (let i = 0; i < turns.length; i += 1) {
      const t = turns[i];
      if (t === undefined) continue;
      const share = Math.max(0, t.output_tokens) / total_output;
      per_turn_totals[i] = total_cost_usd * share;
    }
  }

  const running_sum = per_turn_totals.reduce((a, b) => a + b, 0);
  const remainder = total_cost_usd - running_sum;
  if (turns.length > 0) {
    const last_index = turns.length - 1;
    const current = per_turn_totals[last_index] ?? 0;
    per_turn_totals[last_index] = current + remainder;
  }

  const out: CostBreakdown[] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    if (t === undefined) continue;
    const total = per_turn_totals[i] ?? 0;
    out.push(decompose_total_cost(total, t.usage));
  }
  return out;
}
