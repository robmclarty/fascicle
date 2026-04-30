/**
 * consensus: run-until-agreement.
 *
 * `consensus({ members, agree, max_rounds })` runs every member concurrently
 * with the same input. If `agree(results)` is true, returns the results with
 * `converged: true`. Otherwise re-runs all members up to `max_rounds` times,
 * returning the last results with `converged: false` if no agreement is
 * reached.
 *
 * Implemented as a `compose`d `loop` whose body runs `parallel(members)` and
 * whose guard evaluates `agree`. State carries the original input alongside
 * the most recent results so each round receives the same input.
 */

import { compose, loop, parallel, pipe, scope, stash, step, use } from '@repo/core'
import type { Step } from '@repo/core'

export type ConsensusConfig<i, o> = {
  readonly name?: string
  readonly members: Record<string, Step<i, o>>
  readonly agree: (results: Record<string, o>) => boolean
  readonly max_rounds: number
}

export type ConsensusResult<o> = {
  readonly result: Record<string, o>
  readonly converged: boolean
}

type ConsensusState<i, o> = {
  readonly input: i
  readonly results: Record<string, o>
}

export function consensus<i, o>(
  config: ConsensusConfig<i, o>,
): Step<i, ConsensusResult<o>> {
  const { members, agree, max_rounds } = config

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
  ]) as Step<S, S>

  const guard: Step<S, { stop: boolean; state: S }> = step('agree', (s: S) => ({
    stop: agree(s.results),
    state: s,
  }))

  const inner = pipe(
    loop<i, S, Record<string, o>>({
      init: (input) => ({ input, results: {} }),
      body,
      guard,
      finish: (s) => s.results,
      max_rounds,
    }),
    (result) => ({ result: result.value, converged: result.converged }),
  )

  return compose(config.name ?? 'consensus', inner)
}
