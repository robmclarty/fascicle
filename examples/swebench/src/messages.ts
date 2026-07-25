/**
 * The per-instance user message. Pure string assembly from typed inputs.
 *
 * Kept out of the system prompt because all of it is per case: the repo, the
 * workdir, the issue text, and the two test lists the eval will score.
 */

import type { SweBenchInstance } from './types.js'

export function format_solve_message(instance: SweBenchInstance, workdir: string): string {
  return [
    `Repository: ${instance.repo}`,
    `Working directory: ${workdir}`,
    `Base commit: ${instance.base_commit}`,
    '',
    'Issue:',
    instance.problem_statement,
    instance.hints_text.length > 0 ? `\nHints:\n${instance.hints_text}` : '',
    '',
    'Tests that must flip from failing to passing after your fix:',
    ...instance.fail_to_pass.map((t) => `  - ${t}`),
    '',
    'Tests that must stay passing:',
    ...instance.pass_to_pass.map((t) => `  - ${t}`),
  ].join('\n')
}
