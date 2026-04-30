/**
 * ensemble: N-of-M pick-best.
 *
 * `ensemble({ members, score, select? })` runs every member concurrently with
 * the same input, scores each result, and returns the winner (highest or
 * lowest by `select`) plus the complete score map. Tie-breaking is "any tied
 * result is acceptable".
 *
 * Implemented as a `compose`d `sequence` of `parallel(members)` followed by
 * a single picking step. Cancellation, fan-out, and abort propagation come
 * from `parallel`'s own contract.
 */

import { compose, parallel, sequence, step } from '@repo/core'
import type { Step } from '@repo/core'

export type EnsembleConfig<i, o> = {
  readonly name?: string
  readonly members: Record<string, Step<i, o>>
  readonly score: (result: o, member_id: string) => number | Promise<number>
  readonly select?: 'max' | 'min'
}

export type EnsembleResult<o> = {
  readonly winner: o
  readonly scores: Record<string, number>
}

export function ensemble<i, o>(
  config: EnsembleConfig<i, o>,
): Step<i, EnsembleResult<o>> {
  const select: 'max' | 'min' = config.select ?? 'max'
  const score_fn = config.score
  const keys = Object.keys(config.members)

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const fan_out = parallel(config.members) as Step<i, Record<string, o>>

  const pick = step('pick_winner', async (results: Record<string, o>) => {
    const scores: Record<string, number> = {}
    for (const k of keys) {
      const value = results[k]
      if (value === undefined) continue
      scores[k] = await score_fn(value, k)
    }
  
    let winner_key: string | undefined = undefined
    let winner_score: number | undefined = undefined
    for (const k of keys) {
      const current = scores[k]
      if (current === undefined) continue
      if (winner_score === undefined) {
        winner_key = k
        winner_score = current
        continue
      }
      const better = select === 'max' ? current > winner_score : current < winner_score
      if (better) {
        winner_key = k
        winner_score = current
      }
    }
  
    if (winner_key === undefined) {
      throw new Error('ensemble: no members produced a result')
    }
    const winner = results[winner_key]
    if (winner === undefined) {
      throw new Error('ensemble: winner missing from results')
    }
    return { winner, scores }
  })

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const inner = sequence([fan_out, pick]) as Step<i, EnsembleResult<o>>

  return compose(config.name ?? 'ensemble', inner)
}
