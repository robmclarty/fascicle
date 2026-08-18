/**
 * Stage: coder. The harness's only model role, called once per phase.
 *
 * No output schema: the reply is a one-line prose claim the flow discards,
 * and the test oracle plus the structural backstop are what actually decide
 * whether the phase succeeded. `model_step` (not `model_call`) because
 * nothing reads the result envelope. Message formatting happens in
 * messages.ts; this file is prompt wiring plus a factory.
 */

import { model_step, type Engine, type Step } from 'fascicle'

import { load_prompt } from '../prompts/load.js'

export function make_coder_step(engine: Engine, model: string): Step<string, string> {
  const prompt = load_prompt(new URL('../prompts/coder.md', import.meta.url))
  return model_step({
    engine,
    model,
    system: prompt.body,
    id: 'coder_call',
  })
}
