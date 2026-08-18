/**
 * loop: bounded iteration with carry-state.
 *
 * `loop({ init, body, guard?, finish, max_rounds, name? })` runs `body` up to
 * `max_rounds` times, threading `state` through each iteration. After every
 * `body` call, an optional `guard` step inspects (and may transform) the state
 * and decides whether to stop; a bare `(state) => boolean` predicate is
 * accepted as shorthand for a guard that stops without transforming.
 * When `guard.stop` is true, the loop exits
 * "converged"; otherwise it continues until `max_rounds`. `finish` projects
 * the final state to the loop's output value, and is the loop's only output
 * channel: `loop` returns `Step<i, o>`, not an envelope around `o`.
 *
 * Non-convergence is data, not error, and `finish` is where that data arrives:
 * its second argument is the `LoopOutcome` (`{ converged, rounds }`), so a
 * projection can fold either field into its own result shape, the way
 * `adversarial` and `consensus` do. A projection that wants the whole outcome
 * verbatim writes `finish: (state, outcome) => ({ value: state, ...outcome })`.
 *
 * Cancellation: between rounds the parent `ctx.abort` is honored; a pending
 * abort short-circuits and propagates `ctx.abort.reason`. The body and guard
 * receive the parent context unchanged; their own dispatch routes already
 * thread cancellation per the runner contract.
 */

import { dispatch_step, register_traced_kind, throw_if_aborted } from './runner.js'
import { step } from './step.js'
import type { AnyStep, RunContext, Step } from './types.js'

export type LoopGuardResult<state> = {
  readonly stop: boolean
  readonly state: state
}

export type LoopGuardPredicate<state> = (state: state) => boolean | Promise<boolean>

export type LoopOutcome = {
  readonly converged: boolean
  readonly rounds: number
}

export type LoopConfig<i, state, o> = {
  readonly name?: string
  readonly init: (input: i) => state
  readonly body: Step<state, state>
  readonly guard?: Step<state, LoopGuardResult<state>> | LoopGuardPredicate<state>
  readonly finish: (state: state, outcome: LoopOutcome) => o
  readonly max_rounds: number
}

let loop_counter = 0

/**
 * Generate a unique step id, prefixed with the display name when one is set.
 */
function next_id(name: string | undefined): string {
  loop_counter += 1
  return `${name ?? 'loop'}_${loop_counter}`
}

/**
 * Normalize the guard config to its step form.
 *
 * A bare predicate is sugar for the state-preserving guard step, wrapped here
 * (with an id derived from the loop's, so trees with several loops stay
 * unambiguous) rather than special-cased in the run loop: the predicate form
 * then dispatches, traces, and terminates identically to a hand-written guard.
 */
function wrap_guard<state>(
  guard: Step<state, LoopGuardResult<state>> | LoopGuardPredicate<state> | undefined,
  loop_id: string,
): Step<state, LoopGuardResult<state>> | undefined {
  if (guard === undefined) return undefined
  if (typeof guard !== 'function') return guard
  return step(`${loop_id}_guard`, async (state: state) => ({
    stop: await guard(state),
    state,
  }))
}

/**
 * Build a bounded iteration step with carry-state.
 *
 * Threads `state` through up to `max_rounds` runs of `body`, lets the
 * optional `guard` stop early, then projects the final state through
 * `finish`. `finish` also receives `{ converged, rounds }`, so a projection
 * can tell a converged run from an exhausted one without the loop wrapping
 * its output.
 */
export function loop<i, state, o>(config: LoopConfig<i, state, o>): Step<i, o> {
  const { init, body, finish, name } = config
  const rounds_limit = Math.max(1, Math.floor(config.max_rounds))
  const id = next_id(name)
  const guard = wrap_guard(config.guard, id)

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    let state = init(input)
    let round = 0
    let converged = false
  
    while (round < rounds_limit) {
      throw_if_aborted(ctx)
      round += 1
      state = await dispatch_step(body, state, ctx)
      if (guard) {
        throw_if_aborted(ctx)
        const guard_out = await dispatch_step(guard, state, ctx)
        state = guard_out.state
        if (guard_out.stop) {
          converged = true
          break
        }
      }
    }
  
    return finish(state, { converged, rounds: round })
  }

  const config_meta: Record<string, unknown> = { max_rounds: rounds_limit }
  if (name !== undefined) config_meta['display_name'] = name
  const children: ReadonlyArray<AnyStep> = guard
    ? [body, guard]
    : [body]

  return {
    id,
    kind: 'loop',
    children,
    config: config_meta,
    run: run_fn,
  }
}

register_traced_kind('loop')
