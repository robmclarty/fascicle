/**
 * stdio_agent: a compliant child under the stdio agent contract.
 *
 * A parent program spawns this file, writes JSON to its stdin, and reads one
 * JSON result from its stdout; trajectory goes to stderr and the exit code is
 * the verdict (0 = result, 1 = flow failure, 2 = contract violation).
 * Deterministic stub steps: no engine, no network. A real agent slots
 * `model_call` steps into the same shape and passes its engine to `run_stdio`
 * so it is disposed before the process exits.
 *
 * Run directly:
 *   echo '{"topic":"flaky tests"}' | pnpm exec tsx examples/stdio_agent.ts; echo $?
 *   echo 'not json' | pnpm exec tsx examples/stdio_agent.ts; echo $?
 */

import { z } from 'zod'
import { parallel, run, sequence, step } from 'fascicle'
import { run_stdio } from 'fascicle/stdio'

const input_schema = z.object({ topic: z.string() })
const output_schema = z.object({ headline: z.string(), candidates: z.array(z.string()) })

type Input = z.infer<typeof input_schema>
type Output = z.infer<typeof output_schema>

const punchy = step('punchy', ({ topic }: Input) => `${topic}: what actually changed`)
const measured = step('measured', ({ topic }: Input) => `notes toward ${topic}`)

const synthesize = step(
  'synthesize',
  (drafts: { readonly punchy: string; readonly measured: string }): Output => ({
    headline: drafts.punchy,
    candidates: [drafts.punchy, drafts.measured],
  }),
)

const flow = sequence([parallel({ punchy, measured }), synthesize])

export async function run_stdio_agent(topic = 'stdio contracts'): Promise<Output> {
  return run(flow, { topic }, { install_signal_handlers: false })
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  void run_stdio(flow, { input_schema, output_schema })
}
