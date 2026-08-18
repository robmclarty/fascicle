/**
 * change-triage flow: pure fascicle composition.
 *
 * Read top-to-bottom and you see the agent topology:
 *
 *   chain
 *     ├ input       ← the change set (label + diff text)
 *     ├ files       ← parse_unified_diff (pure)
 *     ├ signals     ← detect_signals (pure, zero tokens)
 *     ├ screened    ← screen_files (privacy gate on the model's view)
 *     ├ assessment  ← assessor via ctx.call (the only model boundary)
 *     └ output: assemble TriageReport (floor + band + factor merge, pure)
 *
 * The single model call sees the screened diff; the detectors already ran
 * over the full diff, so risk in a withheld path is still scored. Formatting
 * and assembly live in messages.ts / render.ts; binding types are inferred
 * from each step's return, so this file declares no state shape at all.
 */

import { chain, type Engine, type Step } from 'fascicle'

import { format_assessor_message } from './messages.js'
import { assemble_report } from './render.js'
import { screen_files } from './screen.js'
import { parse_unified_diff } from './services/diff.js'
import { detect_signals } from './signals.js'
import { make_assessor_step } from './stages/assessor.js'
import type { TriageInput, TriageReport } from './types.js'

export type FlowModels = {
  readonly assessor: string
}

export function build_flow(engine: Engine, models: FlowModels): Step<TriageInput, TriageReport> {
  const assessor = make_assessor_step(engine, models.assessor)

  return chain<TriageInput>()
    .step('files', ({ input }) => parse_unified_diff(input.diff))
    .step('signals', ({ files }) => detect_signals(files))
    .step('screened', ({ files }) => screen_files(files))
    .step('assessment', (s, ctx) =>
      ctx.call(assessor, format_assessor_message(s.input, s.files, s.signals, s.screened)),
    )
    .output(({ input, signals, screened, assessment }) =>
      assemble_report(input, signals, screened, assessment),
    )
}
