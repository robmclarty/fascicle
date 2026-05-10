/**
 * Stage 3 — Builder.
 *
 * Dispatches by provider so the same `Step<string, GenerateResult<Handoff>>`
 * contract works under both surfaces:
 * - `claude_cli` — the CLI's built-in Read/Write/Edit/Glob/Grep/Bash run in
 *   the worktree's cwd (set on the engine in `create_app_engine`).
 * - API providers (`anthropic`, `openrouter`) — explicit worktree-scoped
 *   tools from `make_builder_tools(worktree_root)`.
 */

import { model_call, type Engine, type GenerateResult, type Step } from '@repo/fascicle'

import type { Provider } from '../engine.js'
import { make_builder_tools } from '../tools/index.js'
import { HandoffSchema, type Handoff } from '../types.js'

export const BUILDER_SYSTEM = `pr-improve/stage3/builder
You are a focused code-builder. You receive a small, pre-distilled improvement
spec and (optionally) feedback from a previous attempt. Implement ONLY what
the spec accepts — no scope creep. Stay inside the spec's constraints.

You have file-editing tools available in the current working directory, which
is a git worktree of the target PR's head. Under the claude_cli provider these
are Read, Write, Edit, Glob, Grep, and Bash. Under API providers they are
read_file, write_file, edit_file, list_dir, and run_shell — same purpose,
different names. Apply the spec by editing files in that cwd. Do not run
pnpm install, do not push, do not git-commit — the harness handles version
control.

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

export const CLAUDE_CLI_BUILDER_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const

export function make_builder_call(
  engine: Engine,
  model: string,
  worktree_root: string,
  provider: Provider,
): Step<string, GenerateResult<Handoff>> {
  if (provider === 'claude_cli') {
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
  return model_call({
    engine,
    model,
    system: BUILDER_SYSTEM,
    schema: HandoffSchema,
    schema_repair_attempts: 2,
    id: 'builder_call',
    tools: make_builder_tools(worktree_root),
  })
}
