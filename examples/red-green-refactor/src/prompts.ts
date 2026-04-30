/**
 * Prompt builders for each TDD phase. The agent is told exactly which file
 * paths it may touch in each phase; the structural backstop catches any
 * lying. Prompts are kept small and imperative — the engine does the work.
 */

import type { Behavior } from './behaviors.js'
import type { TestVerdict } from './oracle.js'

export const TOY_TEST_FILE = 'examples/red-green-refactor/toy/src/calculator.test.ts'
export const TOY_IMPL_FILE = 'examples/red-green-refactor/toy/src/calculator.ts'

export const SYSTEM_PROMPT = [
  'You are operating inside a strict TDD harness.',
  'Per turn you may add or change AT MOST one test or one minimal implementation slice.',
  'No splatting tests. No speculative features. No comments narrating what code does.',
  `The implementation lives at ${TOY_IMPL_FILE}.`,
  `The test file lives at ${TOY_TEST_FILE}.`,
  'Edit the files in place. Do not create new files unless absolutely required.',
].join(' ')

export function red_prompt(b: Behavior): string {
  return [
    `RED phase for behavior "${b.id}": ${b.description}`,
    `Add EXACTLY ONE new \`it(...)\` (or \`test(...)\`) call to ${TOY_TEST_FILE}.`,
    'It must currently FAIL because the implementation does not satisfy this behavior yet.',
    `You may NOT modify ${TOY_IMPL_FILE} in this phase.`,
    'Reply with a one-line description of the test you added; do not paste code.',
  ].join('\n')
}

export function green_prompt(b: Behavior, prior?: TestVerdict): string {
  const intro = prior
    ? `GREEN retry for "${b.id}": tests still fail. Last 40 lines of vitest output:\n${prior.tail.split('\n').slice(-40).join('\n')}`
    : `GREEN phase for behavior "${b.id}": ${b.description}`
  return [
    intro,
    `Edit ${TOY_IMPL_FILE} with the MINIMAL change that makes the failing test pass.`,
    `You may NOT modify ${TOY_TEST_FILE}.`,
    'Reply with a one-line description of the change; do not paste code.',
  ].join('\n')
}

export function refactor_prompt(b: Behavior): string {
  return [
    `REFACTOR phase for "${b.id}": tests are green.`,
    `Look at ${TOY_IMPL_FILE} and improve clarity ONLY. Behavior must not change.`,
    `If nothing is worth refactoring, leave the file alone and reply "no refactor".`,
    `You may NOT modify ${TOY_TEST_FILE}.`,
  ].join('\n')
}
