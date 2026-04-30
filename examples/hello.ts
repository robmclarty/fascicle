/**
 * hello: your first fascicle harness.
 *
 * Composes three steps into a flow and runs it. No engine, no network,
 * no API keys required. This is the smallest viable shape of a harness:
 * a flow value, one run call, and a tiny surrounding program.
 *
 * Run directly:
 *   pnpm exec tsx examples/hello.ts
 *   pnpm exec tsx examples/hello.ts "your custom input here"
 */

import { run, sequence, step } from '@repo/fascicle'

const parse = step('parse', (raw: string): readonly string[] =>
  raw.trim().split(/\s+/).filter(Boolean),
)

const reverse_words = step(
  'reverse_words',
  (words: readonly string[]): readonly string[] => words.toReversed(),
)

const join = step('join', (words: readonly string[]): string => words.join(' '))

const flow = sequence([parse, reverse_words, join])

export async function run_hello(input = 'hello world from agent kit'): Promise<{
  readonly input: string
  readonly output: string
}> {
  const output = await run(flow, input, { install_signal_handlers: false })
  return { input, output }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const argv_input = process.argv.slice(2).join(' ')
  const chosen = argv_input.length > 0 ? argv_input : undefined
  run_hello(chosen)
    .then(({ input, output }) => {
      console.log(`input:  ${input}`)
      console.log(`output: ${output}`)
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
