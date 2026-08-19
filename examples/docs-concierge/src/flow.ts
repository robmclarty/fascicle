/**
 * docs-concierge flow: pure Fascicle composition.
 *
 * Read top-to-bottom and you see the agent topology:
 *
 *   chain
 *     ├ input      ← the raw question
 *     ├ question   ← screen_question (privacy scrub, pure)
 *     ├ passages   ← retrieve (Retriever port; local docs by default)
 *     ├ assessment ← answerer via ctx.call (define_agent: markdown prompt + schema)
 *     └ output: gate → Outcome (one-way narrowing toward abstention, pure)
 *
 * Retrieval and the model both see the SCREENED question. The model proposes;
 * the gate decides, and it can only narrow toward abstention, so the agent
 * stays silent rather than confidently wrong. Binding types are inferred
 * from each step's return, so this file declares no state shape at all.
 */

import { chain, type Engine, type Step } from 'fascicle'

import { gate, type GateOptions } from './gate.js'
import { screen_question } from './screen.js'
import type { Retriever } from './services/retriever.js'
import { make_answerer } from './stages/answerer.js'
import type { AskInput, Outcome } from './types.js'

export type FlowModels = {
  readonly answerer: string
}

export type FlowEnv = {
  readonly retriever: Retriever
  /** How many passages to retrieve. */
  readonly k: number
  readonly gate?: GateOptions
}

export function build_flow(engine: Engine, models: FlowModels, env: FlowEnv): Step<AskInput, Outcome> {
  const answerer = make_answerer(engine, models.answerer)

  return chain<AskInput>()
    .step('question', ({ input }) => screen_question(input.question))
    .step('passages', ({ question }) => env.retriever.search(question, env.k))
    .step('assessment', ({ question, passages }, ctx) =>
      ctx.call(answerer, { question, passages }), { arm: answerer })
    .output(({ assessment, passages }) => gate(assessment, passages, env.gate ?? {}))
}
