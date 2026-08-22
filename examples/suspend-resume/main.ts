/**
 * suspend-resume: human-in-the-loop pause and resume.
 *
 * `run.until_suspended` reports the pause as a typed outcome; calling the
 * outcome's `resume(data)` re-runs the flow with the decision and the flow
 * continues into `combine`.
 *
 * Deterministic stub `fn` bodies — no engine layer, no network, no LLM calls.
 *
 * Run directly:
 *   pnpm exec tsx examples/suspend-resume/main.ts
 */

import { z } from 'zod'
import { run, suspend } from 'fascicle'

const flow = suspend({
  id: 'approve',
  on: () => {
    // Side effect: a real flow might notify an operator here.
  },
  resume_schema: z.object({ approved: z.boolean() }),
  combine: (input: { readonly brief: string }, resume) =>
    resume.approved ? `shipped:${input.brief}` : `rejected:${input.brief}`,
})

export async function run_suspend_resume(): Promise<{
  readonly suspended: boolean
  readonly resumed: string
}> {
  const outcome = await run.until_suspended(
    flow,
    { brief: 'beta feature' },
    { install_signal_handlers: false },
  )
  if (outcome.kind !== 'suspended') throw new Error('expected the approval gate to suspend')

  const resumed = await outcome.resume({ approved: true })
  if (resumed.kind !== 'done') throw new Error('expected the resumed run to finish')

  return { suspended: true, resumed: resumed.output }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_suspend_resume()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
