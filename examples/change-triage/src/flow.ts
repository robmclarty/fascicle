/**
 * change-triage flow: pure fascicle composition.
 *
 * Read top-to-bottom and you see the agent topology:
 *
 *   scope
 *     ├ stash INPUT       ← the change set (label + diff text)
 *     ├ stash FILES       ← parse_unified_diff (pure)
 *     ├ stash SIGNALS     ← detect_signals (pure, zero tokens)
 *     ├ stash SCREENED    ← screen_files (privacy gate on the model's view)
 *     ├ stash ASSESSMENT  ← assessor (model_call)
 *     └ assemble TriageReport (floor + band + factor merge, pure)
 *
 * The single model call sees the screened diff; the detectors already ran
 * over the full diff, so risk in a withheld path is still scored. Formatting
 * and assembly live in messages.ts / render.ts and are plugged in through
 * `use(...)` projections so this file stays at the fascicle level.
 */

import {
  scope,
  sequence,
  stash,
  step,
  use,
  type Engine,
  type GenerateResult,
  type Step,
} from 'fascicle'

import { format_assessor_message } from './messages.js'
import { assemble_report } from './render.js'
import { screen_files } from './screen.js'
import { parse_unified_diff } from './services/diff.js'
import { detect_signals } from './signals.js'
import {
  K,
  read_assessment,
  read_files,
  read_input,
  read_screened,
  read_signals,
} from './state.js'
import { make_assessor_call } from './stages/assessor.js'
import type { Assessment, TriageInput, TriageReport } from './types.js'

export type FlowModels = {
  readonly assessor: string
}

export function build_flow(engine: Engine, models: FlowModels): Step<TriageInput, TriageReport> {
  const assessor_call = make_assessor_call(engine, models.assessor)

  const assessor_subflow: Step<unknown, Assessment> = sequence([
    use([K.INPUT, K.FILES, K.SIGNALS, K.SCREENED], (s) =>
      format_assessor_message(read_input(s), read_files(s), read_signals(s), read_screened(s)),
    ),
    assessor_call,
    step('extract_assessment', (r: GenerateResult<Assessment>) => r.content),
  ])

  return scope([
    stash(K.INPUT, step('init_input', (input: TriageInput) => input)),
    stash(K.FILES, use([K.INPUT], (s) => parse_unified_diff(read_input(s).diff))),
    stash(K.SIGNALS, use([K.FILES], (s) => detect_signals(read_files(s)))),
    stash(K.SCREENED, use([K.FILES], (s) => screen_files(read_files(s)))),
    stash(K.ASSESSMENT, assessor_subflow),
    use([K.INPUT, K.SIGNALS, K.SCREENED, K.ASSESSMENT], (s) =>
      assemble_report(read_input(s), read_signals(s), read_screened(s), read_assessment(s)),
    ),
  ])
}
