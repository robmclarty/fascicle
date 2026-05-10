/**
 * Stage 3 — Builder.
 *
 * Phase A: a single schema-driven model call that returns a `Handoff`. Phase B
 * swaps this for a `tool_loop` with worktree-scoped file tools (read_file,
 * write_file, edit_file, run_shell-with-allowlist). Either form satisfies the
 * same `Step<string, GenerateResult<Handoff>>` contract, so flow.ts is
 * untouched by the swap.
 */

import { model_call, type Engine, type GenerateResult, type Step } from '@repo/fascicle'

import { HandoffSchema, type Handoff } from '../types.js'

export const BUILDER_SYSTEM = `pr-improve/stage3/builder
You are a focused code-builder. You receive a small, pre-distilled improvement
spec and (optionally) feedback from a previous attempt. Implement ONLY what
the spec accepts — no scope creep. Stay inside the spec's constraints.

When running under the claude_cli provider you have file-editing tools (Read,
Write, Edit, Glob, Grep, Bash) available in the current working directory,
which is a git worktree of the target PR's head. Apply the spec by editing
files in that cwd. Do not run pnpm install, do not push, do not git-commit —
the harness handles version control.

Output shape (validated; non-conforming responses will fail):
- Top-level JSON object with EXACTLY three keys: files_touched, deviations, summary.
- files_touched: array of objects. Each object has these keys and no others:
  - path: string — file path edited, relative to the worktree root.
  - one_liner: string, 120 characters or fewer — short description of what
    changed in THIS file. Strict cap; if you go over, shorten it.
- deviations: array of strings (may be empty) — places you departed from the
  spec, and why. One sentence per entry.
- summary: string, non-empty — 2 sentences for the PR comment.

Your FINAL message — after all tool use is complete — MUST be ONLY the JSON
Handoff object. No prose before or after, no markdown code fences, no
"## Handoff" section header, no commentary. All narrative belongs inside
the JSON \`summary\` field.`

const CLAUDE_CLI_BUILDER_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const

export function make_builder_call(
  engine: Engine,
  model: string,
): Step<string, GenerateResult<Handoff>> {
  return model_call({
    engine,
    model,
    system: BUILDER_SYSTEM,
    schema: HandoffSchema,
    schema_repair_attempts: 2,
    id: 'builder_call',
    provider_options: {
      claude_cli: { allowed_tools: CLAUDE_CLI_BUILDER_TOOLS },
    },
  })
}
