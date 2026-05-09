/**
 * Stage 2 — Pragmatist.
 *
 * Filters and distills the reviewer's suggestions to a small set of accepted
 * changes. Default verdict is REJECT — the prompt is the load-bearing part of
 * the whole pipeline. Cap = 3 accepted changes.
 */

import { model_call, type Engine, type GenerateResult, type Step } from '@repo/fascicle'

import { PragmatistOutputSchema, type PragmatistOutput } from '../types.js'

export const PRAGMATIST_SYSTEM = `pr-improve/stage2/pragmatist
You are a pragmatic engineering judge. Your default verdict on every suggestion
is REJECT.

ACCEPT a suggestion ONLY when the change clearly:
- reduces complexity, OR
- fixes a real bug, OR
- removes a hazard (security, data loss, race condition).

Style, naming, "could be cleaner", or speculative refactors are NOT enough.

Cap accepted suggestions at 3. Fewer is better. If nothing meets the bar,
return an empty accepted list — that is a successful outcome.

Always justify each acceptance with one sentence on why the change is worth
the complexity it adds.`

export function make_pragmatist_call(
  engine: Engine,
  model: string,
): Step<string, GenerateResult<PragmatistOutput>> {
  return model_call({
    engine,
    model,
    system: PRAGMATIST_SYSTEM,
    schema: PragmatistOutputSchema,
    id: 'pragmatist_call',
  })
}
