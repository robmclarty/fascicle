/**
 * Per-phase user messages. Pure string assembly from typed inputs.
 *
 * Each message names the two toy files explicitly, including which one is off
 * limits for that phase — the phase-specific half of the contract, which is
 * why it lives here and not in the markdown system prompt. The structural
 * backstop catches any lying.
 */

import type { Behavior, TestVerdict } from './types.js'

const TOY_TEST_FILE = 'examples/red-green-refactor/toy/src/calculator.test.ts'
const TOY_IMPL_FILE = 'examples/red-green-refactor/toy/src/calculator.ts'

const VERDICT_TAIL_LINES = 40

export function format_red_message(b: Behavior): string {
  return [
    `RED phase for behavior "${b.id}": ${b.description}`,
    `Add EXACTLY ONE new \`it(...)\` (or \`test(...)\`) call to ${TOY_TEST_FILE}.`,
    'It must currently FAIL because the implementation does not satisfy this behavior yet.',
    `You may NOT modify ${TOY_IMPL_FILE} in this phase.`,
    'Reply with a one-line description of the test you added; do not paste code.',
  ].join('\n')
}

export function format_green_message(b: Behavior, prior?: TestVerdict): string {
  const intro = prior
    ? `GREEN retry for "${b.id}": tests still fail. Last ${String(VERDICT_TAIL_LINES)} lines of vitest output:\n${prior.tail.split('\n').slice(-VERDICT_TAIL_LINES).join('\n')}`
    : `GREEN phase for behavior "${b.id}": ${b.description}`
  return [
    intro,
    `Edit ${TOY_IMPL_FILE} with the MINIMAL change that makes the failing test pass.`,
    `You may NOT modify ${TOY_TEST_FILE}.`,
    'Reply with a one-line description of the change; do not paste code.',
  ].join('\n')
}

export function format_refactor_message(b: Behavior): string {
  return [
    `REFACTOR phase for "${b.id}": tests are green.`,
    `Look at ${TOY_IMPL_FILE} and improve clarity ONLY. Behavior must not change.`,
    'If nothing is worth refactoring, leave the file alone and reply "no refactor".',
    `You may NOT modify ${TOY_TEST_FILE}.`,
  ].join('\n')
}
