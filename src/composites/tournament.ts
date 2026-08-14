/**
 * tournament: pairwise bracket.
 *
 * `tournament({ members, compare })` runs every member, then pairs them off
 * in a single-elimination bracket. `compare(a, b)` returns which result
 * advances. An odd member count yields one bye per affected round. Returns
 * `{ winner, bracket }` where `bracket` lists every match record.
 *
 * Implemented as a `compose`d `sequence` of `parallel(members)` followed
 * by a single bracket-reduction step. Cancellation, fan-out, and abort
 * propagation come from `parallel`'s contract; the bracket step only runs
 * after all members settle.
 */

import { compose, parallel, sequence, step } from '#core'
import type { Step } from '#core'

export type BracketRecord = {
  readonly round: number
  readonly a_id: string
  readonly b_id: string
  readonly winner_id: string
}

export type TournamentConfig<i, o> = {
  readonly name?: string
  readonly members: Record<string, Step<i, o>>
  readonly compare: (a: o, b: o) => Promise<'a' | 'b'> | 'a' | 'b'
}

export type TournamentResult<o> = {
  readonly winner: o
  readonly bracket: ReadonlyArray<BracketRecord>
}

/**
 * Build a single-elimination bracket step over named members.
 *
 * All members run concurrently via `parallel`; the bracket step then reduces
 * survivors round by round with `compare`, recording every match. Requires at
 * least one member so a winner always exists.
 */
export function tournament<i, o>(
  config: TournamentConfig<i, o>,
): Step<i, TournamentResult<o>> {
  const compare_fn = config.compare
  const keys = Object.keys(config.members)

  if (keys.length === 0) {
    throw new Error('tournament: at least one member required')
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const fan_out = parallel(config.members) as Step<i, Record<string, o>>

  const bracket_step = step('bracket', async (results: Record<string, o>) => {
    let current: string[] = [...keys]
    const bracket: BracketRecord[] = []
    let round = 0

    while (current.length > 1) {
      round += 1
      current = await play_round(current, results, compare_fn, round, bracket)
    }

    return { winner: winner_of(current, results), bracket }
  })

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const inner = sequence([fan_out, bracket_step]) as Step<i, TournamentResult<o>>

  return compose(config.name ?? 'tournament', inner)
}

/**
 * Plays one bracket round: pairs survivors two at a time, comparing each pair
 * and recording a `BracketRecord`, and returns the ids advancing. An unpaired
 * trailing survivor takes a bye. Every paired id must have a settled result.
 */
async function play_round<o>(
  current: ReadonlyArray<string>,
  results: Record<string, o>,
  compare: (a: o, b: o) => Promise<'a' | 'b'> | 'a' | 'b',
  round: number,
  bracket: BracketRecord[],
): Promise<string[]> {
  const next_round: string[] = []
  for (let i = 0; i < current.length; i += 2) {
    const a_id = current[i]
    const b_id = current[i + 1]
    if (a_id === undefined) continue
    if (b_id === undefined) {
      next_round.push(a_id)
      continue
    }
    const a_val = results[a_id]
    const b_val = results[b_id]
    if (a_val === undefined || b_val === undefined) {
      throw new Error('tournament: missing result for match')
    }
    const pick = await compare(a_val, b_val)
    const winner_id = pick === 'a' ? a_id : b_id
    bracket.push({ round, a_id, b_id, winner_id })
    next_round.push(winner_id)
  }
  return next_round
}

/**
 * Extracts the tournament winner from the single surviving id, throwing when
 * no survivor remains or its result is missing.
 */
function winner_of<o>(current: ReadonlyArray<string>, results: Record<string, o>): o {
  const final_id = current[0]
  if (final_id === undefined) {
    throw new Error('tournament: no winner')
  }
  const winner = results[final_id]
  if (winner === undefined) {
    throw new Error('tournament: winner missing from results')
  }
  return winner
}
