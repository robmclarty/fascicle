/**
 * Stage 4 — Build-Reviewer.
 *
 * Binary verdict: pass or needs-changes. flow.ts wires this into the loop
 * primitive — the verdict drives the loop's `guard`, and `needs-changes`
 * threads `feedback` into the next iteration's builder prompt.
 */

import { model_step, type Engine, type Step } from 'fascicle'

import { load_prompt } from '../prompts/load.js'
import { build_verdict_schema, type BuildVerdict } from '../types.js'

export function make_build_reviewer_step(
  engine: Engine,
  model: string,
): Step<string, BuildVerdict> {
  const prompt = load_prompt(new URL('../prompts/build_reviewer.md', import.meta.url))
  return model_step({
    engine,
    model,
    system: prompt.body,
    schema: build_verdict_schema,
    schema_repair_attempts: 2,
    id: 'build_reviewer_call',
  })
}
