/**
 * hello_claude_cli: your first fascicle harness that calls a real model.
 *
 * Uses the `claude_cli` subprocess provider, which spawns the `claude` binary
 * and piggybacks on your existing authenticated session. No API key required
 * as long as `claude` is on PATH and you have run `claude login`.
 *
 * Under `auth_mode: 'oauth'` the subprocess env inherits from `process.env`
 * automatically (opt out with `inherit_env: false`). Engine-level `defaults`
 * fill in `model` and `system` so `model_call({ engine })` needs no extra
 * parameters.
 *
 * Run directly:
 *   pnpm exec tsx examples/hello_claude_cli.ts
 *   pnpm exec tsx examples/hello_claude_cli.ts "your prompt here"
 */

import {
  create_engine,
  model_call,
  run,
  sequence,
  step,
  type GenerateResult,
} from '@repo/fascicle'

const engine = create_engine({
  providers: { claude_cli: { auth_mode: 'oauth' } },
  defaults: {
    model: 'cli-sonnet',
    system: 'Reply in one short sentence. No preamble.',
  },
})

const ask = model_call({ engine })

const extract = step(
  'extract',
  (result: GenerateResult<unknown>): string =>
    typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
)

const flow = sequence([ask, extract])

export async function run_hello_claude_cli(
  input = 'say hello to fascicle',
): Promise<{ readonly input: string; readonly output: string }> {
  const output = await run(flow, input, { install_signal_handlers: false })
  return { input, output }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const argv_input = process.argv.slice(2).join(' ')
  const chosen = argv_input.length > 0 ? argv_input : undefined
  run_hello_claude_cli(chosen)
    .then(({ input, output }) => {
      console.log(`input:  ${input}`)
      console.log(`output: ${output}`)
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
    .finally(() => {
      void engine.dispose()
    })
}
