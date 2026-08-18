/**
 * ensemble: N-of-M pick-best with a plain-function scorer.
 */

import { compose, parallel, sequence, step } from '#core'
import type { Step } from '#core'

export type EnsembleConfig<i, o, projected = EnsembleResult<o>> = {
  readonly name?: string
  readonly members: Record<string, Step<i, o>>
  readonly score: (result: o, member_id: string) => number | Promise<number>
  readonly select?: 'max' | 'min'
  readonly project?: (r: EnsembleResult<o>) => projected
}

export type EnsembleResult<o> = {
  readonly winner: o
  readonly scores: Record<string, number>
}

/**
 * Builds a Step that runs every member concurrently with the same input,
 * scores each result, and returns the winner plus the complete score map.
 *
 * `select` picks the highest (`'max'`, the default) or lowest (`'min'`)
 * score. Tie-breaking is "any tied result is acceptable": the first member
 * (in `members` key order) holding the best score wins. `project` maps the
 * `{ winner, scores }` envelope into the step's output (e.g. `(r) =>
 * r.winner`); omitted, the envelope itself is the output.
 *
 * Implemented as a `compose`d `sequence` of `parallel(members)` followed by
 * a single picking step. Cancellation, fan-out, and abort propagation come
 * from `parallel`'s own contract.
 */
export function ensemble<i, o, projected = EnsembleResult<o>>(
  config: EnsembleConfig<i, o, projected>,
): Step<i, projected> {
  const select: 'max' | 'min' = config.select ?? 'max'
  const score_fn = config.score
  const keys = Object.keys(config.members)
  // When `project` is omitted, `projected` defaults to the envelope type, which is
  // what the identity fallback's cast records.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const project = config.project ?? ((r: EnsembleResult<o>) => r as unknown as projected)

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
    return project({ winner, scores })
  })

  const inner = sequence([fan_out, pick])

  return compose(config.name ?? 'ensemble', inner)
}
