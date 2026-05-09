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

When done, output a Handoff describing:
- files_touched: paths and one-liners
- deviations: any place you departed from the spec, and why
- summary: 2 sentences for the PR comment.`

export function make_builder_call(
  engine: Engine,
  model: string,
): Step<string, GenerateResult<Handoff>> {
  return model_call({
    engine,
    model,
    system: BUILDER_SYSTEM,
    schema: HandoffSchema,
    id: 'builder_call',
  })
}
