/**
 * Stage: assessor. The pipeline's only model boundary.
 *
 * Loads the markdown system prompt and returns a `model_step` with the
 * assessment schema attached, so the step's output is the validated
 * `Assessment` itself and flow.ts composes it without unwrapping. Message
 * formatting happens in flow.ts via messages.ts; this file is prompt wiring
 * plus a factory. `schema_repair_attempts` lets the engine re-prompt small
 * local models that drop a field or wrap the JSON in prose.
 *
 * This is the stage-factory tier deliberately, shown alongside
 * docs-concierge's `define_agent` stage as the blueprint's two prompt-loading
 * mechanisms. Drop to `model_call` in a factory like this when the caller
 * needs the `GenerateResult` envelope (usage, cost, tool calls) rather than
 * just the answer.
 */

import { model_step, type Engine, type Step } from 'fascicle'

import { load_prompt } from '../prompts/load.js'
import { assessment_schema, type Assessment } from '../types.js'

export function make_assessor_step(
  engine: Engine,
  model: string,
): Step<string, Assessment> {
  const prompt = load_prompt(new URL('../prompts/assessor.md', import.meta.url))
  return model_step({
    engine,
    model,
    system: prompt.body,
    schema: assessment_schema,
    schema_repair_attempts: 2,
    id: 'assessor_call',
  })
}
