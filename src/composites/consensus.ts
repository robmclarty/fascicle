/**
 * consensus: run-until-agreement composite over concurrent members.
 */

import { compose, loop, parallel, scope, stash, step, use } from '#core'
import type { Step } from '#core'

export type ConsensusConfig<i, o, projected = ConsensusResult<o>> = {
  readonly name?: string
  readonly members: Record<string, Step<i, o>>
  readonly agree: (results: Record<string, o>) => boolean
  readonly max_rounds: number
  readonly project?: (r: ConsensusResult<o>) => projected
}

export type ConsensusResult<o> = {
  readonly result: Record<string, o>
  readonly converged: boolean
}

type ConsensusState<i, o> = {
  readonly input: i
  readonly results: Record<string, o>
}

/**
 * Builds a Step that runs every member concurrently with the same input
 * until `agree(results)` accepts a round.
 *
 * On agreement, returns the round's results with `converged: true`.
 * Otherwise re-runs all members up to `max_rounds` times and returns the
 * last results with `converged: false` if no agreement is reached.
 * `project` maps the `{ result, converged }` envelope into the step's output
 * (for example, `(r) => r.converged`); omitted, the envelope itself is the output.
 *
 * Implemented as a `compose`d `loop` whose body runs `parallel(members)` and
 * whose guard evaluates `agree`. State carries the original input alongside
 * the most recent results so each round receives the same input.
 */
export function consensus<i, o, projected = ConsensusResult<o>>(
  config: ConsensusConfig<i, o, projected>,
): Step<i, projected> {
  const { members, agree, max_rounds } = config
  // When `project` is omitted, `projected` defaults to the envelope type, which is
  // what the identity fallback's cast records.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const project = config.project ?? ((r: ConsensusResult<o>) => r as unknown as projected)

  type S = ConsensusState<i, o>

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const round_step = parallel(members) as Step<i, Record<string, o>>

  const body: Step<S, S> = scope([
    stash('state', step('snapshot', (s: S) => s)),
    step('extract_input', (s: S) => s.input),
    round_step,
    use(['state'], (vars, results: Record<string, o>) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const prior = vars['state'] as S
      return { ...prior, results }
    }),
  ])

  const guard: Step<S, { stop: boolean; state: S }> = step('agree', (s: S) => ({
    stop: agree(s.results),
    state: s,
  }))

  const inner = loop<i, S, projected>({
    init: (input) => ({ input, results: {} }),
    body,
    guard,
    finish: (s, { converged }) => project({ result: s.results, converged }),
    max_rounds,
  })

  return compose(config.name ?? 'consensus', inner)
}
