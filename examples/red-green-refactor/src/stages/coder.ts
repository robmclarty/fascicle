/**
 * Stage: coder. The harness's only model role, called once per phase.
 *
 * No output schema: the reply is a one-line prose claim, and the test oracle
 * plus the structural backstop are what actually decide whether the phase
 * succeeded. Message formatting happens in messages.ts; this file is prompt
 * wiring plus a factory.
 */

import { model_call, type Engine, type GenerateResult, type Step } from 'fascicle'

import { load_prompt } from '../prompts/load.js'

export function make_coder_call(engine: Engine, model: string): Step<string, GenerateResult> {
  const prompt = load_prompt(new URL('../prompts/coder.md', import.meta.url))
  return model_call({
    engine,
    model,
    system: prompt.body,
    id: 'coder_call',
  })
}
