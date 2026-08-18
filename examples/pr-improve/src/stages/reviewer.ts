/**
 * Stage 1 — Reviewer.
 *
 * Reads the PR diff and emits up to 10 structured suggestions. Schema-driven
 * via `model_step({ schema })`.  * happen in flow.ts; this file is prompt wiring plus a factory.
 */

import { model_step, type Engine, type Step } from 'fascicle'

import { load_prompt } from '../prompts/load.js'
import { reviewer_output_schema, type ReviewerOutput } from '../types.js'

export function make_reviewer_step(
  engine: Engine,
  model: string,
): Step<string, ReviewerOutput> {
  const prompt = load_prompt(new URL('../prompts/reviewer.md', import.meta.url))
  return model_step({
    engine,
    model,
    system: prompt.body,
    schema: reviewer_output_schema,
    schema_repair_attempts: 2,
    id: 'reviewer_call',
  })
}
