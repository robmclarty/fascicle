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
automated noise. You compare the spec to the handoff and return one of two
verdicts:

- pass: build addresses the spec correctly.
- needs-changes: build is wrong, incomplete, or violates constraints.

Default to needs-changes if the handoff is vague. Be strict — a low-quality
"pass" wastes the original author's time more than another build round.

Output shape (validated; non-conforming responses will fail). Top-level JSON
object discriminated on a \`kind\` field, EXACTLY one of two shapes:

For a passing build:
  {
    "kind": "pass",
    "summary": <string, non-empty — 2 sentences suitable for a PR comment>,
    "rationale": <string, non-empty — one paragraph justifying the pass>
  }

For a build that needs changes:
  {
    "kind": "needs-changes",
    "feedback": <string, non-empty — concrete, actionable feedback for the
                next builder round>
  }

Output format: respond with ONLY the JSON object. No prose before or after,
no markdown code fences, no commentary.`

export function make_build_reviewer_call(
  engine: Engine,
  model: string,
): Step<string, GenerateResult<BuildVerdict>> {
  return model_call({
    engine,
    model,
    system: BUILD_REVIEWER_SYSTEM,
    schema: BuildVerdictSchema,
    schema_repair_attempts: 2,
    id: 'build_reviewer_call',
  })
}
