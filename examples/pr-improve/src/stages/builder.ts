/**
 * Stage 3 — Builder.
 *
 * Dispatches by provider so the same `Step<string, Handoff>`
 * contract works under both surfaces:
 * - `claude_cli` — the CLI's built-in Read/Write/Edit/Glob/Grep/Bash run in
 *   the worktree's cwd (set on the engine in `create_app_engine`).
 * - API providers (`anthropic`, `openrouter`) — explicit worktree-scoped
 *   tools from `make_builder_tools(worktree_root)`.
 */

import { model_step, type Engine, type Step } from 'fascicle'

import type { Provider } from '../engine.js'
import { load_prompt } from '../prompts/load.js'
import { make_builder_tools } from '../tools/index.js'
import { handoff_schema, type Handoff } from '../types.js'

export const CLAUDE_CLI_BUILDER_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const

export function make_builder_step(
  engine: Engine,
  model: string,
  worktree_root: string,
  provider: Provider,
): Step<string, Handoff> {
  const prompt = load_prompt(new URL('../prompts/builder.md', import.meta.url))
  if (provider === 'claude_cli') {
    return model_step({
      engine,
      model,
      system: prompt.body,
      schema: handoff_schema,
      schema_repair_attempts: 2,
      id: 'builder_call',
      provider_options: {
        claude_cli: { allowed_tools: CLAUDE_CLI_BUILDER_TOOLS },
      },
    })
  }
  return model_step({
    engine,
    model,
    system: prompt.body,
    schema: handoff_schema,
    schema_repair_attempts: 2,
    id: 'builder_call',
    tools: make_builder_tools(worktree_root),
  })
}
