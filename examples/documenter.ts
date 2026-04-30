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
 */

import { documenter, type DocumenterOutput } from '@repo/agents'
import { run } from '@repo/fascicle'
import type { Engine, GenerateOptions, GenerateResult } from '@repo/fascicle'

function make_stub_engine(canned: DocumenterOutput): Engine {
  return {
    generate: async <t = string>(
      opts: GenerateOptions<t>,
    ): Promise<GenerateResult<t>> => {
      const parsed = opts.schema ? opts.schema.parse(canned) : canned
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: parsed as t,
        tool_calls: [],
        steps: [],
        usage: { input_tokens: 80, output_tokens: 40 },
        finish_reason: 'stop',
        model_resolved: { provider: 'stub', model_id: 'documenter-canned' },
      }
    },
    register_alias: () => {},
    unregister_alias: () => {},
    resolve_alias: () => ({ provider: 'stub', model_id: 'documenter-canned' }),
    list_aliases: () => ({}),
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    dispose: async () => {},
  }
}

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
  const engine = make_stub_engine(canned)
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
