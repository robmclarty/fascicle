/**
 * Stage 1 — Reviewer.
 *
 * Reads the PR diff and emits up to 10 structured suggestions. Schema-driven
 * via `model_call({ schema })`. Message formatting and content extraction
 * happen in flow.ts; this file is just system prompt + model_call.
 */

import { model_call, type Engine, type GenerateResult, type Step } from '@repo/fascicle'

import { ReviewerOutputSchema, type ReviewerOutput } from '../types.js'

export const REVIEWER_SYSTEM = `pr-improve/stage1/reviewer
You are a senior code reviewer. Review the PR diff for clarity, correctness,
and complexity. Do NOT propose stylistic preferences or speculative refactors.
Cap your output at 10 suggestions. Each must have stable id, file, line range,
category, severity, one-liner, rationale, and proposed change sketch.`

export function make_reviewer_call(
  engine: Engine,
  model: string,
): Step<string, GenerateResult<ReviewerOutput>> {
  return model_call({
    engine,
    model,
    system: REVIEWER_SYSTEM,
    schema: ReviewerOutputSchema,
    id: 'reviewer_call',
  })
}
