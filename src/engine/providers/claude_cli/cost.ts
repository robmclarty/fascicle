/**
 * Cost allocation from the CLI's reported `total_cost_usd`.
 *
 * The CLI reports a single total_cost_usd and per-turn usage; it does not
 * break cost down by component or by turn. This module splits the total
 * across turns proportional to each turn's output tokens, then hands each
 * turn's share to the engine's `decompose_total_cost` for the component
 * split. Sum equality is preserved exactly by giving any floating-point
 * rounding remainder to the last turn.
 */

import { decompose_total_cost } from '../../pricing.js'
import type { CostBreakdown, UsageTotals } from '../../types.js'

export type TurnUsage = {
  readonly output_tokens: number
  readonly usage: UsageTotals
}

/**
 * Split a run-level `total` into a per-turn share for each turn, proportional
 * to its output tokens, falling back to an equal split when every turn reports
 * zero output (the proportional weights would otherwise all be zero). The last
 * turn absorbs the floating-point rounding remainder so the shares sum exactly
 * to `total`. Caller guarantees a non-empty `turns`.
 *
 * The CLI reports cost and API time for the whole run only, and both go
 * through this one split so a step's share of each stays consistent.
 */
export function split_total_across_turns(
  total: number,
  turns: ReadonlyArray<Pick<TurnUsage, 'output_tokens'>>,
): number[] {
  const total_output = turns.reduce((sum, t) => sum + Math.max(0, t.output_tokens), 0)
  const per_turn = turns.map((t) =>
    total_output === 0
      ? total / turns.length
      : total * (Math.max(0, t.output_tokens) / total_output),
  )

  const assigned = per_turn.reduce((a, b) => a + b, 0)
  const last_index = turns.length - 1
  per_turn[last_index] = (per_turn[last_index] ?? 0) + (total - assigned)
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
