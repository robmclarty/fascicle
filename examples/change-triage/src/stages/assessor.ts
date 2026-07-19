/**
 * Stage: assessor. The pipeline's only model boundary.
 *
 * Loads the markdown system prompt and returns a `model_call` step with the
 * assessment schema attached. Message formatting and result extraction happen
 * in flow.ts via messages.ts; this file is prompt wiring plus a factory.
 * `schema_repair_attempts` lets the engine re-prompt small local models that
 * drop a field or wrap the JSON in prose.
 *
 * This is the stage-factory tier deliberately, to show it alongside
 * docs-concierge's `define_agent` stage — the blueprint's two prompt-loading
 * mechanisms. This role happens to only read `.content`, so it could be a
 * `define_agent`; keep the factory when you need the `GenerateResult` envelope
 * (usage, cost, tool calls) or `model_call` options like `tools`.
 */

import { model_call, type Engine, type GenerateResult, type Step } from 'fascicle'

import { load_prompt } from '../prompts/load.js'
import { assessment_schema, type Assessment } from '../types.js'

export function make_assessor_call(
  engine: Engine,
  model: string,
): Step<string, GenerateResult<Assessment>> {
  const prompt = load_prompt(new URL('../prompts/assessor.md', import.meta.url))
  return model_call({
    engine,
    model,
    system: prompt.body,
    schema: assessment_schema,
    schema_repair_attempts: 2,
    id: 'assessor_call',
  })
}
