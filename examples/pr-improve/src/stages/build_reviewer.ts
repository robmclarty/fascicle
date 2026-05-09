/**
 * Stage 4 — Build-Reviewer.
 *
 * Binary verdict: pass or needs-changes. flow.ts wires this into the loop
 * primitive — the verdict drives the loop's `guard`, and `needs-changes`
 * threads `feedback` into the next iteration's builder prompt.
 */

import { model_call, type Engine, type GenerateResult, type Step } from '@repo/fascicle'

import { BuildVerdictSchema, type BuildVerdict } from '../types.js'

export const BUILD_REVIEWER_SYSTEM = `pr-improve/stage4/build_reviewer
You are the gate that protects the original PR author from low-quality
automated noise. You compare the spec to the handoff and return one of:

- pass: build addresses the spec correctly. Provide a 2-sentence summary
  suitable for posting as a PR comment, plus a one-paragraph rationale.
- needs-changes: build is wrong, incomplete, or violates constraints.
  Provide concrete, actionable feedback for the next round.

Default to needs-changes if the handoff is vague. Be strict — a low-quality
"pass" wastes the original author's time more than another build round.`

export function make_build_reviewer_call(
  engine: Engine,
  model: string,
): Step<string, GenerateResult<BuildVerdict>> {
  return model_call({
    engine,
    model,
    system: BUILD_REVIEWER_SYSTEM,
    schema: BuildVerdictSchema,
    id: 'build_reviewer_call',
  })
}
