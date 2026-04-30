/**
 * RGR cycle as a fascicle flow.
 *
 * The cycle is a single `scope` so we can stash the Behavior and the
 * pre-RED test snapshot at the top, then `use` them later in each
 * phase (which mostly emit other types — TestVerdict, GenerateResult).
 *
 * RED is a one-shot guarded by two assertions: vitest must go red, AND
 * the snapshot diff must show exactly one new test definition.
 *
 * GREEN is an `adversarial` loop: build = (impl prompt -> model_call ->
 * vitest); accept = passed; max_rounds bounds cost.
 *
 * REFACTOR is a sequence guarded by "tests must still pass AND test
 * files must be byte-identical to the post-RED snapshot."
 */

import {
  adversarial,
  model_call,
  scope,
  sequence,
  stash,
  step,
  timeout,
  use,
  type AdversarialBuildInput,
  type AdversarialCritiqueResult,
  type AdversarialResult,
  type Engine,
  type GenerateResult,
  type Step,
} from '@repo/fascicle'

import {
  assert_one_test_added,
  assert_tests_unchanged,
  snapshot_tests,
  type Snapshot,
} from './backstop.js'
import type { Behavior } from './behaviors.js'
import { run_tests, type TestVerdict } from './oracle.js'
import { green_prompt, red_prompt, refactor_prompt, SYSTEM_PROMPT } from './prompts.js'

const STASH_BEHAVIOR = 'behavior'
const STASH_BEFORE_RED = 'snapshot_before_red'
const STASH_AFTER_RED = 'snapshot_after_red'

const PER_BEHAVIOR_TIMEOUT_MS = 10 * 60 * 1000
const GREEN_MAX_ROUNDS = 4

function read_behavior(state: { readonly [k: string]: unknown }): Behavior {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[STASH_BEHAVIOR] as Behavior
}

function read_snapshot(state: { readonly [k: string]: unknown }, key: string): Snapshot {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return state[key] as Snapshot
}

export function build_cycle(engine: Engine): Step<Behavior, undefined> {
  const ask = model_call({ engine, system: SYSTEM_PROMPT })
  const discard = step('discard_generate_result', (_: GenerateResult<unknown>) => undefined)

  const red_phase: Step<unknown, undefined> = sequence([
    use([STASH_BEHAVIOR], (s) => red_prompt(read_behavior(s))),
    ask,
    discard,
    run_tests,
    step('assert_red', (verdict: TestVerdict) => {
      if (verdict.passed) {
        const tail = verdict.tail.split('\n').slice(-20).join('\n')
        throw new Error(`RED failed: vitest passed but should have failed.\n${tail}`)
      }
      return undefined
    }),
    stash(STASH_AFTER_RED, step('snap_after_red', () => snapshot_tests())),
    use([STASH_BEFORE_RED, STASH_AFTER_RED], (s) => {
      assert_one_test_added(read_snapshot(s, STASH_BEFORE_RED), read_snapshot(s, STASH_AFTER_RED))
      return undefined
    }),
  ])

  const green_build: Step<AdversarialBuildInput<Behavior, TestVerdict>, TestVerdict> = sequence([
    step('build_green_prompt', (i: AdversarialBuildInput<Behavior, TestVerdict>) =>
      green_prompt(i.input, i.prior),
    ),
    ask,
    discard,
    run_tests,
  ])

  const green_loop = adversarial<Behavior, TestVerdict>({
    build: green_build,
    critique: step('green_verdict', (v: TestVerdict) => ({
      verdict: v.passed ? ('pass' as const) : ('fail' as const),
      notes: v.tail,
    })),
    accept: (c: AdversarialCritiqueResult) => c['verdict'] === 'pass',
    max_rounds: GREEN_MAX_ROUNDS,
  })

  const green_phase: Step<unknown, undefined> = sequence([
    use([STASH_BEHAVIOR], (s) => read_behavior(s)),
    green_loop,
    step('assert_green_converged', (r: AdversarialResult<TestVerdict>) => {
      if (!r.converged) {
        const tail = r.candidate.tail.split('\n').slice(-20).join('\n')
        throw new Error(`GREEN did not converge in ${String(r.rounds)} rounds.\n${tail}`)
      }
      return undefined
    }),
    use([STASH_AFTER_RED], async (s) => {
      const now = await snapshot_tests()
      assert_tests_unchanged(read_snapshot(s, STASH_AFTER_RED), now, 'GREEN')
      return undefined
    }),
  ])

  const refactor_phase: Step<unknown, undefined> = sequence([
    use([STASH_BEHAVIOR], (s) => refactor_prompt(read_behavior(s))),
    ask,
    discard,
    run_tests,
    step('assert_still_green', (verdict: TestVerdict) => {
      if (!verdict.passed) {
        const tail = verdict.tail.split('\n').slice(-20).join('\n')
        throw new Error(`REFACTOR broke tests:\n${tail}`)
      }
      return undefined
    }),
    use([STASH_AFTER_RED], async (s) => {
      const now = await snapshot_tests()
      assert_tests_unchanged(read_snapshot(s, STASH_AFTER_RED), now, 'REFACTOR')
      return undefined
    }),
  ])

  const cycle: Step<unknown, undefined> = scope([
    stash(STASH_BEHAVIOR, step('init_behavior', (b: Behavior) => b)),
    stash(STASH_BEFORE_RED, step('snap_before_red', () => snapshot_tests())),
    red_phase,
    green_phase,
    refactor_phase,
    step('cycle_done', () => undefined),
  ])

  return timeout(cycle, PER_BEHAVIOR_TIMEOUT_MS)
}
