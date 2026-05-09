/**
 * User-message builders for each stage.
 *
 * Each function takes the data it needs and returns a string suitable for
 * `model_call` input. No fascicle imports here — these are pure formatters
 * that flow.ts plugs in via `use(...)` projections.
 */

import type { Handoff, PRContext, PragmatistOutput, Suggestion } from './types.js'
import type { LoopState } from './state.js'

export function format_reviewer_message(pr: PRContext): string {
  return [
    `# PR ${String(pr.number)} on ${pr.repo}: ${pr.title}`,
    '',
    '## Project context',
    pr.project_context.length > 0 ? pr.project_context : '(none)',
    '',
    '## Diff',
    '```diff',
    pr.diff,
    '```',
  ].join('\n')
}

export function format_pragmatist_message(
  pr: PRContext,
  suggestions: ReadonlyArray<Suggestion>,
): string {
  return [
    `# PR ${String(pr.number)}: ${pr.title}`,
    '',
    '## Original diff',
    '```diff',
    pr.diff,
    '```',
    '',
    '## Reviewer suggestions',
    JSON.stringify(suggestions, null, 2),
    '',
    '## Your task',
    'Decide which suggestions clear the bar above. Output JSON conforming to the schema.',
  ].join('\n')
}

export function format_builder_message(
  pr: PRContext,
  spec: PragmatistOutput,
  loop_state: LoopState,
): string {
  const next_round = loop_state.round + 1
  const feedback_block =
    loop_state.previous_feedback === null
      ? ''
      : ['## Feedback from previous attempt', loop_state.previous_feedback, ''].join('\n')
  return [
    `# Build round ${String(next_round)} for PR #${String(pr.number)}`,
    '',
    '## Spec (accepted changes)',
    JSON.stringify(spec.accepted, null, 2),
    '',
    '## Constraints',
    spec.constraints.length === 0 ? '(none)' : spec.constraints.map((c) => `- ${c}`).join('\n'),
    '',
    feedback_block,
    '## Original PR diff (for context only)',
    '```diff',
    pr.diff,
    '```',
  ].join('\n')
}

export function format_build_review_message(
  pr: PRContext,
  spec: PragmatistOutput,
  handoff: Handoff,
  loop_state: LoopState,
): string {
  const round = loop_state.round + 1
  return [
    `# Review build round ${String(round)} for PR #${String(pr.number)}`,
    '',
    '## Spec',
    JSON.stringify(spec, null, 2),
    '',
    '## Handoff from builder',
    JSON.stringify(handoff, null, 2),
    '',
    '## Your task',
    'Return a BuildVerdict. Default to needs-changes if anything is off.',
  ].join('\n')
}
