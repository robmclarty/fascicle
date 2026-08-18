/**
 * red-green-refactor flow: pure fascicle composition.
 *
 * Read top-to-bottom and you see the agent topology:
 *
 *   timeout(10 min)
 *     └ chain 'behavior'
 *         ├ before_red      ← snapshot the toy's test files
 *         ├ stage 'red'     ─ ask → run tests → assert red → snapshot →
 *         │                   assert exactly one test added
 *         ├ stage 'green'   ─ adversarial(build = ask → run tests,
 *         │                   accept = passed) → assert converged →
 *         │                   assert tests unchanged
 *         └ stage 'refactor' ─ ask → run tests → assert still green →
 *                             assert tests unchanged
 *
 * RED is a one-shot guarded by two assertions: vitest must go red, AND the
 * snapshot diff must show exactly one new test definition. GREEN is an
 * `adversarial` loop bounded at four rounds. REFACTOR may not touch a test
 * file, which the post-phase snapshot comparison enforces.
 *
 * The test oracle and the snapshotter arrive as ports on `FlowEnv`, so the
 * flow never spawns a process itself and a test can inject scripted phases.
 * Snapshots thread through chain bindings (`before_red`, `after_red`), so
 * this file declares no state shape at all.
 */

import {
  adversarial,
  chain,
  step,
  timeout,
  type AdversarialBuildInput,
  type AdversarialCritiqueResult,
  type Engine,
  type Step,
} from 'fascicle'

import { assert_one_test_added, assert_tests_unchanged } from './backstop.js'
import { format_green_message, format_red_message, format_refactor_message } from './messages.js'
import type { Snapshotter } from './services/snapshot.js'
import type { TestOracle } from './services/vitest.js'
import { make_coder_step } from './stages/coder.js'
import type { Behavior, FlowModels, Snapshot, TestVerdict } from './types.js'

const PER_BEHAVIOR_TIMEOUT_MS = 10 * 60 * 1000
export const GREEN_MAX_ROUNDS = 4

const VERDICT_TAIL_LINES = 20

export type FlowEnv = {
  readonly oracle: TestOracle
  readonly snapshot: Snapshotter
}

function verdict_tail(tail: string): string {
  return tail.split('\n').slice(-VERDICT_TAIL_LINES).join('\n')
}

export function build_flow(
  engine: Engine,
  models: FlowModels,
  env: FlowEnv,
): Step<Behavior, undefined> {
  const ask = make_coder_step(engine, models.coder)
  const run_tests = step('run_tests', (_input: unknown, ctx) => env.oracle(ctx.abort))

  const green_build: Step<AdversarialBuildInput<Behavior, TestVerdict>, TestVerdict> = step(
    'green_round',
    async (i, ctx) => {
      await ctx.call(ask, format_green_message(i.input, i.prior))
      return ctx.call(run_tests, undefined)
    },
  )

  const green_loop = adversarial<Behavior, TestVerdict>({
    build: green_build,
    critique: step('green_verdict', (v: TestVerdict) => ({
      verdict: v.passed ? ('pass' as const) : ('fail' as const),
      notes: v.tail,
    })),
    accept: (c: AdversarialCritiqueResult) => c['verdict'] === 'pass',
    max_rounds: GREEN_MAX_ROUNDS,
  })

  const cycle = chain<Behavior, 'behavior'>('behavior')
    .step('before_red', () => env.snapshot())
    .stage('red')
    .step('red_ask', async ({ behavior }, ctx) => {
      await ctx.call(ask, format_red_message(behavior))
      return undefined
    }, { arm: ask })
    .step('red_verdict', (_s, ctx) => ctx.call(run_tests, undefined), { arm: run_tests })
    .step('assert_red', ({ red_verdict }) => {
      if (red_verdict.passed) {
        throw new Error(
          `RED failed: vitest passed but should have failed.\n${verdict_tail(red_verdict.tail)}`,
        )
      }
      return undefined
    })
    .step('after_red', () => env.snapshot())
    .step('one_test_added', ({ before_red, after_red }) => {
      assert_one_test_added(before_red, after_red)
      return undefined
    })
    .stage('green')
    .step('green', ({ behavior }, ctx) => ctx.call(green_loop, behavior), { arm: green_loop })
    .step('assert_green_converged', ({ green }) => {
      if (!green.converged) {
        throw new Error(
          `GREEN did not converge in ${String(green.rounds)} rounds.\n${verdict_tail(green.candidate.tail)}`,
        )
      }
      return undefined
    })
    .step('green_tests_frozen', ({ after_red }) => assert_tests_frozen(env, after_red, 'GREEN'))
    .stage('refactor')
    .step('refactor_ask', async ({ behavior }, ctx) => {
      await ctx.call(ask, format_refactor_message(behavior))
      return undefined
    }, { arm: ask })
    .step('refactor_verdict', (_s, ctx) => ctx.call(run_tests, undefined), { arm: run_tests })
    .step('assert_still_green', ({ refactor_verdict }) => {
      if (!refactor_verdict.passed) {
        throw new Error(`REFACTOR broke tests:\n${verdict_tail(refactor_verdict.tail)}`)
      }
      return undefined
    })
    .step('refactor_tests_frozen', ({ after_red }) => assert_tests_frozen(env, after_red, 'REFACTOR'))
    .output(() => undefined)

  return timeout(cycle, PER_BEHAVIOR_TIMEOUT_MS)
}

/**
 * Re-snapshot the toy's test files and assert none changed during `phase`.
 *
 * Every phase after RED compares against the post-RED snapshot, so the one
 * test RED added is the only test that may exist for this behavior and no
 * later phase can make a failure go away by editing it.
 */
async function assert_tests_frozen(
  env: FlowEnv,
  after_red: Snapshot,
  phase: string,
): Promise<undefined> {
  const now = await env.snapshot()
  assert_tests_unchanged(after_red, now, phase)
  return undefined
}
