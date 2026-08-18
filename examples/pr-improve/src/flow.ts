/**
 * pr-improve flow — pure fascicle composition.
 *
 * Read top-to-bottom and you see the agent topology:
 *
 *   chain 'pr'
 *     ├ suggestions ← reviewer via ctx.call (model_step)
 *     └ output ← branch (any suggestions?)
 *         then ─ chain 'review'
 *           ├ spec ← pragmatist via ctx.call (model_step)
 *           └ output ← branch (any accepted?)
 *               then ─ chain 'accepted'
 *                 ├ final_state ← loop({ body: build+review, guard: pass? })
 *                 └ output: assemble FinalResult
 *               otherwise ─ FinalResult { no_changes_proposed }
 *         otherwise ─ FinalResult { no_changes_proposed }
 *
 * Each model boundary is a `model_step` invoked via `ctx.call` and declared
 * as `arm` metadata so `describe` renders the whole tree. Formatting helpers
 * live in messages.ts / render.ts; the build-review loop threads
 * `{ pr, spec, state }` as carry-state (state.ts holds the LoopState
 * transitions), so no ambient scope keys remain.
 */

import {
  branch,
  chain,
  loop,
  step,
  type Engine,
  type Step,
} from 'fascicle'

import type { Provider } from './engine.js'
import {
  format_build_review_message,
  format_builder_message,
  format_pragmatist_message,
  format_reviewer_message,
} from './messages.js'
import { assemble_final_result } from './render.js'
import {
  initial_loop_state,
  loop_converged,
  next_loop_state,
  type LoopState,
} from './state.js'
import { make_build_reviewer_step } from './stages/build_reviewer.js'
import { make_builder_step } from './stages/builder.js'
import { make_pragmatist_step } from './stages/pragmatist.js'
import { make_reviewer_step } from './stages/reviewer.js'
import type { FinalResult, FlowModels, PRContext, PragmatistOutput, Suggestion } from './types.js'

export const MAX_BUILD_REVIEW_ROUNDS = 3

export type FlowEnv = {
  readonly worktree_root: string
  readonly provider: Provider
}

// The record each branch level threads forward: the PR plus what the prior
// model stages concluded about it.
type ReviewCtx = {
  readonly pr: PRContext
  readonly suggestions: ReadonlyArray<Suggestion>
}

type AcceptedCtx = ReviewCtx & { readonly spec: PragmatistOutput }

// Loop carry-state: the PR and spec ride alongside the mutable loop state so
// the build-review iteration is a static Step.
type BuildCarry = {
  readonly pr: PRContext
  readonly spec: PragmatistOutput
  readonly state: LoopState
}

export function build_flow(
  engine: Engine,
  models: FlowModels,
  env: FlowEnv,
): Step<PRContext, FinalResult> {
  const reviewer = make_reviewer_step(engine, models.reviewer)
  const pragmatist = make_pragmatist_step(engine, models.pragmatist)
  const builder = make_builder_step(engine, models.builder, env.worktree_root, env.provider)
  const build_reviewer = make_build_reviewer_step(engine, models.build_reviewer)

  const emit_no_changes: Step<ReviewCtx, FinalResult> = step('no_changes', (c) => ({
    kind: 'no_changes_proposed',
    pr: c.pr,
    suggestions: c.suggestions,
  }))

  const build_iteration = chain<BuildCarry, 'carry'>('carry')
    .step('handoff', ({ carry }, ctx) =>
      ctx.call(builder, format_builder_message(carry.pr, carry.spec, carry.state)),
      { arm: builder })
    .step('verdict', ({ carry, handoff }, ctx) =>
      ctx.call(build_reviewer, format_build_review_message(carry.pr, carry.spec, handoff, carry.state)),
      { arm: build_reviewer })
    .output(({ carry, handoff, verdict }): BuildCarry => ({
      ...carry,
      state: next_loop_state(carry.state, handoff, verdict),
    }))

  const build_review_loop = loop<AcceptedCtx, BuildCarry, LoopState>({
    name: 'build_review',
    init: (c) => ({ pr: c.pr, spec: c.spec, state: initial_loop_state }),
    body: build_iteration,
    guard: step('check_pass', (c: BuildCarry) => ({ stop: loop_converged(c.state), state: c })),
    finish: (c) => c.state,
    max_rounds: MAX_BUILD_REVIEW_ROUNDS,
  })

  const with_build = chain<AcceptedCtx, 'accepted'>('accepted')
    .step('final_state', ({ accepted }, ctx) => ctx.call(build_review_loop, accepted),
      { arm: build_review_loop })
    .output(({ accepted, final_state }) =>
      assemble_final_result(accepted.pr, accepted.spec, final_state, accepted.suggestions),
    )

  const accept_gate = branch<AcceptedCtx, FinalResult>({
    name: 'has_accepted_changes',
    when: (c) => c.spec.accepted.length > 0,
    then: with_build,
    otherwise: emit_no_changes,
  })

  const with_pragmatist = chain<ReviewCtx, 'review'>('review')
    .step('spec', ({ review }, ctx) =>
      ctx.call(pragmatist, format_pragmatist_message(review.pr, review.suggestions)),
      { arm: pragmatist })
    .step('result', ({ review, spec }, ctx) => ctx.call(accept_gate, { ...review, spec }),
      { arm: accept_gate })
    .output(({ result }) => result)

  const suggestion_gate = branch<ReviewCtx, FinalResult>({
    name: 'has_suggestions',
    when: (c) => c.suggestions.length > 0,
    then: with_pragmatist,
    otherwise: emit_no_changes,
  })

  return chain<PRContext, 'pr'>('pr')
    .step('suggestions', async ({ pr }, ctx) =>
      (await ctx.call(reviewer, format_reviewer_message(pr))).suggestions,
      { arm: reviewer })
    .step('result', ({ pr, suggestions }, ctx) => ctx.call(suggestion_gate, { pr, suggestions }),
      { arm: suggestion_gate })
    .output(({ result }) => result)
}
