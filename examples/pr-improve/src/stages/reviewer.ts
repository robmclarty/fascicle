/**
 * Stage 1 — Reviewer.
 *
 * Reads the PR diff and emits up to 10 structured suggestions. Schema-driven
 * via `model_call({ schema })`. Message formatting and content extraction
 * happen in flow.ts; this file is just system prompt + model_call.
 */

import { model_call, type Engine, type GenerateResult, type Step } from 'fascicle'

import { ReviewerOutputSchema, type ReviewerOutput } from '../types.js'

export const REVIEWER_SYSTEM = `pr-improve/stage1/reviewer
You are a senior code reviewer. Review the PR diff for clarity, correctness,
and complexity. Do NOT propose stylistic preferences or speculative refactors.
Cap your output at 10 suggestions. Each must have stable id, file, line range,
category, severity, one-liner, rationale, and proposed change sketch.

Hard schema constraints (these are validated and will fail your response if
violated):
- one_liner: 120 characters or fewer. Put detail in rationale and
  proposed_change, never in one_liner.
- category: exactly one of bug, clarity, naming, duplication, safety, perf.
- severity: exactly one of low, medium, high.

Output format: respond with ONLY the JSON object that matches the schema.
No prose before or after, no markdown code fences, no commentary.`

export function make_reviewer_call(
  engine: Engine,
  model: string,
): Step<string, GenerateResult<ReviewerOutput>> {
  return model_call({
    engine,
    model,
    system: REVIEWER_SYSTEM,
    schema: ReviewerOutputSchema,
    schema_repair_attempts: 2,
    id: 'reviewer_call',
  })
}
