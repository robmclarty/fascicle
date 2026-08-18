/**
 * documenter: generate documentation for a single function literal against a
 * stubbed engine.
 *
 * The example demonstrates how the markdown-defined `documenter` agent
 * accepts either a file or a symbol target and threads the requested style
 * through. The engine here is a stub returning a canned, schema-conforming
 * doc — swap it for `create_engine({...})` to run against a real provider.
 *
 * Run directly:
 *   pnpm exec tsx examples/documenter.ts
 *
 * The agent definition itself is demo code in `./agents/` — copy it alongside
 * this file when porting the example into your own project.
 */

import { documenter, type DocumenterOutput } from './agents/documenter/index.js'
import { run } from 'fascicle'
import { make_stub_engine } from 'fascicle/testing'

const canned: DocumenterOutput = {
  doc: [
    '/**',
    ' * Sums an array of numbers.',
    ' *',
    ' * @param xs - the input numbers',
    ' * @returns the arithmetic sum; 0 for an empty array',
    ' */',
  ].join('\n'),
  inferred_purpose: 'Reduces an array of numbers to its arithmetic sum.',
}

export async function run_documenter(): Promise<{
  readonly result: DocumenterOutput
}> {
  const engine = make_stub_engine([{ prefix: '', content: canned }])
  try {
    const agent = documenter({ engine })
    const result = await run(
      agent,
      {
        target: {
          kind: 'symbol',
          name: 'sum',
          signature: 'function sum(xs: ReadonlyArray<number>): number',
          body: 'return xs.reduce((a, b) => a + b, 0);',
        },
        style: 'tsdoc',
      },
      { install_signal_handlers: false },
    )
    return { result }
  } finally {
    await engine.dispose()
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_documenter()
    .then(({ result }) => {
      console.log(`inferred purpose: ${result.inferred_purpose}\n`)
      console.log(result.doc)
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
