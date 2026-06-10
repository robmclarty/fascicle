/**
 * suspend_resume: human-in-the-loop pause and resume.
 *
 * First invocation pauses at `suspend`; second invocation supplies the
 * decision via `resume_data` and the flow continues into `combine`.
 *
 * Deterministic stub `fn` bodies — no engine layer, no network, no LLM calls.
 *
 * Run directly:
 *   pnpm exec tsx examples/suspend_resume.ts
 */

import { z } from 'zod'
import { run, suspend, suspended_error } from 'fascicle'

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
  let suspended = false
  try {
    await run(flow, { brief: 'beta feature' }, { install_signal_handlers: false })
  } catch (err) {
    if (err instanceof suspended_error) suspended = true
    else throw err
  }

  const resumed = await run(flow, { brief: 'beta feature' }, {
    install_signal_handlers: false,
    resume_data: { approve: { approved: true } },
  })

  return { suspended, resumed }
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
