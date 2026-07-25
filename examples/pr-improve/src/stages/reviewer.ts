/**
 * Stage 1 — Reviewer.
 *
 * Reads the PR diff and emits up to 10 structured suggestions. Schema-driven
 * via `model_call({ schema })`. Message formatting and content extraction
 * happen in flow.ts; this file is prompt wiring plus a factory.
 */

import { model_call, type Engine, type GenerateResult, type Step } from 'fascicle'

import { load_prompt } from '../prompts/load.js'
import { reviewer_output_schema, type ReviewerOutput } from '../types.js'

export function make_reviewer_call(
  engine: Engine,
  model: string,
): Step<string, GenerateResult<ReviewerOutput>> {
  const prompt = load_prompt(new URL('../prompts/reviewer.md', import.meta.url))
  return model_call({
    engine,
    model,
    system: prompt.body,
    schema: reviewer_output_schema,
    schema_repair_attempts: 2,
    id: 'reviewer_call',
  })
}
