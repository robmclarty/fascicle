/**
 * pr-improve flow — pure fascicle composition.
 *
 * Read top-to-bottom and you see the agent topology:
 *
 *   scope
 *     ├ stash PR
 *     ├ stash SUGGESTIONS  ← reviewer (model_call)
 *     └ branch (any suggestions?)
 *         then ─ scope
 *           ├ stash SPEC  ← pragmatist (model_call)
 *           └ branch (any accepted?)
 *               then ─ scope
 *                 ├ stash LOOP_RESULT  ← loop({ body: build+review, guard: pass? })
 *                 └ assemble FinalResult
 *               otherwise ─ FinalResult { no_changes_proposed }
 *         otherwise ─ FinalResult { no_changes_proposed }
 *
 * Each model call is its own dispatched step; format/render/state-transition
 * helpers live in messages.ts / render.ts / state.ts and are plugged in via
 * `use(...)` projections so this file stays at the fascicle level.
 */

import {
  branch,
  loop,
  scope,
  sequence,
  stash,
  step,
  use,
  type Engine,
  type GenerateResult,
  type Step,
} from '@repo/fascicle'

import {
  format_build_review_message,
  format_builder_message,
  format_pragmatist_message,
  format_reviewer_message,
} from './messages.js'
import { assemble_final_result } from './render.js'
import {
  initial_loop_state,
  K,
  loop_converged,
  next_loop_state,
  read_handoff,
  read_loop_input,
  read_loop_result,
  read_pr,
  read_spec,
  read_suggestions,
  read_verdict,
  type LoopState,
} from './state.js'
import { make_build_reviewer_call } from './stages/build_reviewer.js'
import { make_builder_call } from './stages/builder.js'
import { make_pragmatist_call } from './stages/pragmatist.js'
import { make_reviewer_call } from './stages/reviewer.js'
import type { BuildVerdict, FinalResult, Handoff, PRContext, PragmatistOutput, ReviewerOutput, Suggestion } from './types.js'

export const MAX_BUILD_REVIEW_ROUNDS = 3

export type FlowModels = {
  readonly reviewer: string
  readonly pragmatist: string
  readonly builder: string
  readonly build_reviewer: string
}

export function build_flow(engine: Engine, models: FlowModels): Step<PRContext, FinalResult> {
  const reviewer_call = make_reviewer_call(engine, models.reviewer)
  const pragmatist_call = make_pragmatist_call(engine, models.pragmatist)
  const builder_call = make_builder_call(engine, models.builder)
  const build_reviewer_call = make_build_reviewer_call(engine, models.build_reviewer)

  const reviewer_subflow: Step<unknown, ReadonlyArray<Suggestion>> = sequence([
    use([K.PR], (s) => format_reviewer_message(read_pr(s))),
    reviewer_call,
    step('extract_suggestions', (r: GenerateResult<ReviewerOutput>) => r.content.suggestions),
  ])

  const pragmatist_subflow: Step<unknown, PragmatistOutput> = sequence([
    use([K.PR, K.SUGGESTIONS], (s) =>
      format_pragmatist_message(read_pr(s), read_suggestions(s)),
    ),
    pragmatist_call,
    step('extract_spec', (r: GenerateResult<PragmatistOutput>) => r.content),
  ])

  const build_review_iteration: Step<LoopState, LoopState> = scope([
    stash(K.LOOP_INPUT, step('preserve_loop_state', (ls: LoopState) => ls)),
    stash(
      K.HANDOFF,
      sequence([
        use([K.PR, K.SPEC, K.LOOP_INPUT], (s) =>
          format_builder_message(read_pr(s), read_spec(s), read_loop_input(s)),
        ),
        builder_call,
        step('extract_handoff', (r: GenerateResult<Handoff>) => r.content),
      ]),
    ),
    stash(
      K.VERDICT,
      sequence([
        use([K.PR, K.SPEC, K.LOOP_INPUT, K.HANDOFF], (s) =>
          format_build_review_message(read_pr(s), read_spec(s), read_handoff(s), read_loop_input(s)),
        ),
        build_reviewer_call,
        step('extract_verdict', (r: GenerateResult<BuildVerdict>) => r.content),
      ]),
    ),
    use([K.LOOP_INPUT, K.HANDOFF, K.VERDICT], (s) =>
      next_loop_state(read_loop_input(s), read_handoff(s), read_verdict(s)),
    ),
  ])

  const build_review_loop = loop<unknown, LoopState, LoopState>({
    name: 'build_review',
    init: () => initial_loop_state,
    body: build_review_iteration,
    guard: step('check_pass', (state: LoopState) => ({ stop: loop_converged(state), state })),
    finish: (state) => state,
    max_rounds: MAX_BUILD_REVIEW_ROUNDS,
  })

  const emit_no_changes: Step<unknown, FinalResult> = use([K.PR, K.SUGGESTIONS], (s) => ({
    kind: 'no_changes_proposed',
    pr: read_pr(s),
    suggestions: read_suggestions(s),
  }))

  const with_build: Step<PragmatistOutput, FinalResult> = scope([
    stash(K.LOOP_RESULT, build_review_loop),
    use([K.PR, K.SPEC, K.LOOP_RESULT, K.SUGGESTIONS], (s) =>
      assemble_final_result(read_pr(s), read_spec(s), read_loop_result(s), read_suggestions(s)),
    ),
  ])

  const with_pragmatist: Step<ReadonlyArray<Suggestion>, FinalResult> = scope([
    stash(K.SPEC, pragmatist_subflow),
    branch<PragmatistOutput, FinalResult>({
      name: 'has_accepted_changes',
      when: (spec) => spec.accepted.length > 0,
      then: with_build,
      otherwise: emit_no_changes,
    }),
  ])

  return scope([
    stash(K.PR, step('init_pr', (pr: PRContext) => pr)),
    stash(K.SUGGESTIONS, reviewer_subflow),
    branch<ReadonlyArray<Suggestion>, FinalResult>({
      name: 'has_suggestions',
      when: (suggestions) => suggestions.length > 0,
      then: with_pragmatist,
      otherwise: emit_no_changes,
    }),
  ])
}
