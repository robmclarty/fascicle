/**
 * researcher: bespoke iterative agent driven by injected search and fetch.
 *
 * Wires the `researcher` agent against a stub engine plus mock `search` and
 * `fetch` functions. The engine returns one canned summarizer result; the
 * mocks return a tiny in-memory corpus. The example proves the abstraction
 * end-to-end without any network or API keys.
 *
 * To drive against real services, replace `make_stub_engine` with
 * `create_engine({...})` and provide real `search` / `fetch` implementations.
 *
 * Run directly:
 *   pnpm exec tsx examples/researcher.ts
 */

import { researcher, type ResearcherOutput, type SummarizerOutput } from '@repo/agents'
import { run } from '@repo/fascicle'
import type { Engine, GenerateOptions, GenerateResult } from '@repo/fascicle'

function make_stub_engine(canned: SummarizerOutput): Engine {
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
        usage: { input_tokens: 300, output_tokens: 120 },
        finish_reason: 'stop',
        model_resolved: { provider: 'stub', model_id: 'researcher-canned' },
      }
    },
    register_alias: () => {},
    unregister_alias: () => {},
    resolve_alias: () => ({ provider: 'stub', model_id: 'researcher-canned' }),
    list_aliases: () => ({}),
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    dispose: async () => {},
  }
}

const corpus: Readonly<Record<string, { readonly title: string; readonly contents: string }>> = {
  'https://example.test/composition': {
    title: 'Composition over inheritance',
    contents:
      'Functional composition lets you express small parts and combine them. Fascicle treats every flow as a value.',
  },
  'https://example.test/effects': {
    title: 'Effects at the edges',
    contents:
      'A flow stays a value until you call run(); only then do effects run. Tests build the same value without I/O.',
  },
}

const canned_summary: SummarizerOutput = {
  notes:
    'Fascicle expresses flows as values. Composition is the unit of reuse. Effects are deferred to run().',
  brief:
    'Fascicle is a small TypeScript library that treats agentic workflows as plain values: small composers snap together into a flow that only takes effect when you call run(). The point is testability and inspectability without ambient state.',
  refined_query: 'fascicle composition vs framework',
  has_enough: true,
  new_sources: [
    {
      url: 'https://example.test/composition',
      title: 'Composition over inheritance',
      quote: 'Fascicle treats every flow as a value.',
    },
    {
      url: 'https://example.test/effects',
      title: 'Effects at the edges',
      quote: 'A flow stays a value until you call run().',
    },
  ],
}

export async function run_researcher(): Promise<{
  readonly result: ResearcherOutput
}> {
  const engine = make_stub_engine(canned_summary)
  try {
    const agent = researcher({
      engine,
      search: async (_query) => [
        {
          url: 'https://example.test/composition',
          title: corpus['https://example.test/composition']?.title ?? '',
          snippet: 'compose small parts',
        },
        {
          url: 'https://example.test/effects',
          title: corpus['https://example.test/effects']?.title ?? '',
          snippet: 'effects at the edges',
        },
      ],
      fetch: async (url) => corpus[url]?.contents ?? '',
    })
    const result = await run(
      agent,
      { query: 'what makes fascicle different', depth: 'shallow' },
      { install_signal_handlers: false },
    )
    return { result }
  } finally {
    await engine.dispose()
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_researcher()
    .then(({ result }) => {
      console.log(`brief: ${result.brief}\n`)
      console.log('sources:')
      for (const s of result.sources) {
        const t = s.title ? ` — ${s.title}` : ''
        console.log(`  - ${s.url}${t}`)
        if (s.quote) console.log(`      "${s.quote}"`)
      }
      console.log(`\nnotes:\n${result.notes}`)
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
