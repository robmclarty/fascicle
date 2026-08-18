/**
 * Stage 2 — Pragmatist.
 *
 * Filters and distills the reviewer's suggestions to a small set of accepted
 * changes. Default verdict is REJECT — the prompt is the load-bearing part of
 * the whole pipeline. Cap = 3 accepted changes.
 */

import { model_step, type Engine, type Step } from 'fascicle'

import { load_prompt } from '../prompts/load.js'
import { pragmatist_output_schema, type PragmatistOutput } from '../types.js'

export function make_pragmatist_step(
  engine: Engine,
  model: string,
): Step<string, PragmatistOutput> {
  const prompt = load_prompt(new URL('../prompts/pragmatist.md', import.meta.url))
  return model_step({
    engine,
    model,
    system: prompt.body,
    schema: pragmatist_output_schema,
    schema_repair_attempts: 2,
    id: 'pragmatist_call',
  })
}
