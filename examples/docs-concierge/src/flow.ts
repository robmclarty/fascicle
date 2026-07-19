/**
 * docs-concierge flow: pure fascicle composition.
 *
 * Read top-to-bottom and you see the agent topology:
 *
 *   scope
 *     ├ stash QUESTION   ← screen_question (privacy scrub, pure)
 *     ├ stash PASSAGES   ← retrieve (Retriever port; local docs by default)
 *     ├ stash ASSESSMENT ← answerer (define_agent: markdown prompt + schema)
 *     └ gate → Outcome   (one-way narrowing toward abstention, pure)
 *
 * Retrieval and the model both see the SCREENED question. The model proposes;
 * the gate decides, and it can only narrow toward abstention, so the agent
 * stays silent rather than confidently wrong.
 */

import { scope, sequence, stash, step, use, type Engine, type Step } from 'fascicle'

import { gate, type GateOptions } from './gate.js'
import { screen_question } from './screen.js'
import type { Retriever } from './services/retriever.js'
import { K, read_assessment, read_passages, read_question } from './state.js'
import { make_answerer } from './stages/answerer.js'
import type { AskInput, Outcome, Passage } from './types.js'

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

  const retrieve_subflow: Step<unknown, ReadonlyArray<Passage>> = sequence([
    use([K.QUESTION], (s) => read_question(s)),
    step('retrieve', async (question: string) => env.retriever.search(question, env.k)),
  ])

  const answerer_subflow: Step<unknown, unknown> = sequence([
    use([K.QUESTION, K.PASSAGES], (s) => ({
      question: read_question(s),
      passages: read_passages(s),
    })),
    answerer,
  ])

  return scope([
    stash(K.QUESTION, step('screen_question', (input: AskInput) => screen_question(input.question))),
    stash(K.PASSAGES, retrieve_subflow),
    stash(K.ASSESSMENT, answerer_subflow),
    use([K.ASSESSMENT, K.PASSAGES], (s) =>
      gate(read_assessment(s), read_passages(s), env.gate ?? {}),
    ),
  ])
}
