/**
 * Prompt construction. Kept in its own file so swapping the prompt — the
 * single biggest lever on resolution rate — is a one-line change without
 * touching the flow wiring.
 */

import type { SweBenchInstance } from './types.js'

export const SOLVE_SYSTEM_PROMPT = [
  'You are a senior engineer fixing a real issue in an open source repository.',
  'You have these tools: read_file, write_file, run_command, list_files, grep_files.',
  'Investigate the codebase first with read_file/grep_files, decide on a minimal fix,',
  'edit the relevant files with write_file, and verify with run_command (run the',
  'existing tests for the area you changed). Stop once the fix is applied — the',
  'harness will capture your changes with `git diff`. Do not commit, do not push.',
].join(' ')

export function build_initial_prompt(instance: SweBenchInstance, workdir: string): string {
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
    '',
    'When you are confident the fix is right, stop replying. The harness will',
    'capture your changes via `git diff` against the base commit.',
  ].join('\n')
}
