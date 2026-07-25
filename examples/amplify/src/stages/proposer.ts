/**
 * Stage: proposer. One candidate per call, structured as JSON.
 *
 * Schema-driven via `model_call({ schema })`: if the model produces malformed
 * output the engine repairs it, and if repair is exhausted the step throws.
 * The flow turns that throw into a failed candidate, which becomes a lesson.
 */

import { model_call, type Engine, type GenerateResult, type Step } from 'fascicle'
import { z } from 'zod'

import { load_prompt } from '../prompts/load.js'

const proposal_schema = z.object({
  rationale: z.string().min(1).describe('One line on why this change should move the metric.'),
  content: z.string().min(1).describe('The COMPLETE new contents of the file. Not a diff.'),
})

export type Proposal = z.infer<typeof proposal_schema>

export function make_proposer_call(
  engine: Engine,
  model: string,
): Step<string, GenerateResult<Proposal>> {
  const prompt = load_prompt(new URL('../prompts/proposer.md', import.meta.url))
  return model_call({
    engine,
    model,
    system: prompt.body,
    schema: proposal_schema,
    schema_repair_attempts: 2,
    id: 'proposer_call',
  })
}
