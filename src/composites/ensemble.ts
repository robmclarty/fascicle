/**
 * ensemble: N-of-M pick-best with a plain-function scorer.
 */

import { compose, parallel, sequence, step } from '#core'
import type { Step } from '#core'

export type EnsembleConfig<i, o, projected = EnsembleResult<o>> = {
  readonly name?: string
  readonly description?: string
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
 * (in `members` key order) holding the best score wins. A member that
 * returns `undefined` is scored like any other, and a NaN score stays in the
 * score map but never wins, so a field whose every score is NaN throws. `project` maps the
 * `{ winner, scores }` envelope into the step's output (for example, `(r) =>
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

  if (keys.length === 0) {
    throw new Error('ensemble: at least one member required')
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const fan_out = parallel(config.members) as Step<i, Record<string, o>>

  const pick = step('pick_winner', async (results: Record<string, o>) => {
    const scores: Record<string, number> = {}
    const ranked: Array<readonly [string, number]> = []
    for (const k of keys) {
      // Stryker disable next-line ConditionalExpression: parallel throws unless every member settles, so each key has a result, even an undefined one.
      if (!Object.hasOwn(results, k)) continue
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const score = await score_fn(results[k] as o, k)
      scores[k] = score
      ranked.push([k, score])
    }

    const winner_key = best_of(ranked, select)
    if (winner_key === undefined) {
      throw new Error(
        'ensemble: every score was NaN, so no member can win; make score return a number for each result',
      )
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return project({ winner: results[winner_key] as o, scores })
  })

  const inner = sequence([fan_out, pick])

  return compose(inner, { name: config.name ?? 'ensemble', description: config.description })
}

/**
 * The member whose score is best under `select`, the first in `ranked` order
 * on a tie, or `undefined` when every score is NaN. A NaN score never wins,
 * wherever it falls, because no reading of "best" includes it.
 */
function best_of(ranked: ReadonlyArray<readonly [string, number]>, select: 'max' | 'min'): string | undefined {
  let best: readonly [string, number] | undefined
  for (const entry of ranked) {
    const score = entry[1]
    if (Number.isNaN(score)) continue
    if (best === undefined || (select === 'max' ? score > best[1] : score < best[1])) best = entry
  }
  return best?.[0]
}
