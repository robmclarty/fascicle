/**
 * Cost decomposition from the CLI's reported `total_cost_usd`.
 *
 * The CLI reports a single total_cost_usd and per-turn usage; it does not
 * break cost down by component or by turn. This module synthesizes a
 * component split by computing an implied per-million-token rate from the
 * total and allocating that rate to each token component, weighted by
 * `CACHE_READ_MULTIPLIER` and `CACHE_WRITE_MULTIPLIER`.
 *
 * Per-turn allocation splits `total_cost_usd` across turns proportional to
 * each turn's output tokens. Sum equality is preserved exactly by giving
 * any floating-point rounding remainder to the last turn.
 */

import type { CostBreakdown, UsageTotals } from '../../types.js'
import { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER } from './constants.js'

/**
 * Split a single `total_cost_usd` figure into an input/output cost
 * breakdown, weighted by token counts.
 *
 * Cache-read and cache-write tokens are cheaper and pricier respectively
 * than base input tokens, so they're weighted by `CACHE_READ_MULTIPLIER`
 * and `CACHE_WRITE_MULTIPLIER` before the total is distributed
 * proportionally across all weighted components. Returns an all-zero
 * estimate when there's no usage or no cost to distribute.
 */
export function decompose_total_cost(
  total_cost_usd: number,
  usage: UsageTotals,
): CostBreakdown {
  const input = Math.max(0, usage.input_tokens)
  const output = Math.max(0, usage.output_tokens)
  const cached = Math.max(0, usage.cached_input_tokens ?? 0)
  const cache_write = Math.max(0, usage.cache_write_tokens ?? 0)

  const base_input = Math.max(0, input - cached - cache_write)

  const input_weight = base_input
  const output_weight = output
  const cached_weight = cached * CACHE_READ_MULTIPLIER
  const cache_write_weight = cache_write * CACHE_WRITE_MULTIPLIER

  const total_weight = input_weight + output_weight + cached_weight + cache_write_weight

  if (total_weight === 0 || total_cost_usd === 0) {
    return {
      total_usd: total_cost_usd,
      input_usd: 0,
      output_usd: 0,
      currency: 'USD',
      is_estimate: true,
    }
  }

  const input_usd = (total_cost_usd * input_weight) / total_weight
  const output_usd = (total_cost_usd * output_weight) / total_weight
  const cached_usd_raw = (total_cost_usd * cached_weight) / total_weight
  const cache_write_usd_raw = (total_cost_usd * cache_write_weight) / total_weight

  const breakdown: CostBreakdown = {
    total_usd: total_cost_usd,
    input_usd,
    output_usd,
    currency: 'USD',
    is_estimate: true,
  }
  if (cached > 0) breakdown.cached_input_usd = cached_usd_raw
  if (cache_write > 0) breakdown.cache_write_usd = cache_write_usd_raw
  return breakdown
}

export type TurnUsage = {
  readonly output_tokens: number
  readonly usage: UsageTotals
}

/**
 * Split `total_cost_usd` into a per-turn total for each turn, proportional to
 * its output tokens, falling back to an equal split when every turn reports
 * zero output (the proportional weights would otherwise all be zero). The last
 * turn absorbs the floating-point rounding remainder so the shares sum exactly
 * to `total_cost_usd`. Caller guarantees a non-empty `turns`.
 */
function split_total_across_turns(
  total_cost_usd: number,
  turns: ReadonlyArray<TurnUsage>,
): number[] {
  const total_output = turns.reduce((sum, t) => sum + Math.max(0, t.output_tokens), 0)
  const per_turn = turns.map((t) =>
    total_output === 0
      ? total_cost_usd / turns.length
      : total_cost_usd * (Math.max(0, t.output_tokens) / total_output),
  )

  const assigned = per_turn.reduce((a, b) => a + b, 0)
  const last_index = turns.length - 1
  per_turn[last_index] = (per_turn[last_index] ?? 0) + (total_cost_usd - assigned)
  return per_turn
}

/**
 * Split a call's total cost across its turns, proportional to each turn's
 * output tokens, then decompose each turn's share into a `CostBreakdown`.
 *
 * Falls back to an equal split when every turn reports zero output tokens
 * (the proportional weights would otherwise all be zero). The last turn
 * absorbs the floating-point rounding remainder so the per-turn totals sum
 * exactly to `total_cost_usd`.
 */
export function allocate_cost_across_turns(
  total_cost_usd: number,
  turns: ReadonlyArray<TurnUsage>,
): ReadonlyArray<CostBreakdown> {
  if (turns.length === 0) return []
  const per_turn = split_total_across_turns(total_cost_usd, turns)
  return turns.map((t, i) => decompose_total_cost(per_turn[i] ?? 0, t.usage))
}
