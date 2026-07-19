/**
 * docs-concierge CLI entry: the shell.
 *
 *   pnpm --filter @repo/example-docs-concierge ask:stub
 *   tsx src/main.ts "Who can delete a project?"
 *   tsx src/main.ts --provider ollama --json "How do exports work?"
 *
 * Parses input, builds the engine and retriever, calls `run(...)` once, and
 * renders the typed Outcome after it returns. An abstention is a successful
 * run, not an error; the exit code stays 0.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { run } from 'fascicle'

import { create_app_engine, make_stub_engine, read_engine_env, type Provider } from './engine.js'
import { build_flow } from './flow.js'
import { render_human, render_json } from './render.js'
import { make_docs_retriever } from './services/retriever.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_DOCS_DIR = join(HERE, '..', 'docs')
const DEFAULT_K = 4

type CliArgs = {
  readonly question: string
  readonly docs: string
  readonly k: number
  readonly stub: boolean
  readonly json: boolean
  readonly provider?: Provider
}

function parse_argv(argv: ReadonlyArray<string>): CliArgs {
  const args = argv.slice(2)
  const positional: string[] = []
  let docs = DEFAULT_DOCS_DIR
  let k = DEFAULT_K
  let stub = false
  let json = false
  let provider: Provider | undefined
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--stub') stub = true
    else if (a === '--json') json = true
    else if (a === '--docs') {
      docs = args[i + 1] ?? docs
      i += 1
    } else if (a === '--k') {
      k = Number.parseInt(args[i + 1] ?? '', 10)
      if (!Number.isFinite(k) || k <= 0) throw new Error('--k expects a positive integer')
      i += 1
    } else if (a === '--provider') {
      const raw = args[i + 1]
      const found = (['anthropic', 'ollama', 'claude_cli'] as const).find((p) => p === raw)
      if (found === undefined) throw new Error('--provider must be one of anthropic, ollama, claude_cli')
      provider = found
      i += 1
    } else if (a !== undefined) positional.push(a)
  }
  const question = positional.join(' ').trim()
  if (question.length === 0) {
    throw new Error('Usage: tsx src/main.ts [--stub] [--json] [--docs <dir>] [--k <n>] "<question>"')
  }
  const out: CliArgs = { question, docs, k, stub, json }
  if (provider !== undefined) Object.assign(out, { provider })
  return out
}

const STUB_ASSESSMENT = {
  abstain: false,
  confidence: 'high',
  answer: 'Only workspace admins can delete a project; editors can archive but not delete. [1]',
  citations: [1],
}

async function main(): Promise<number> {
  const args = parse_argv(process.argv)
  const cfg = args.stub ? undefined : read_engine_env(process.env, args.provider)
  const engine = cfg
    ? create_app_engine(cfg)
    : make_stub_engine([{ match_system_prefix: 'docs-concierge/answerer', content: STUB_ASSESSMENT }])
  const models = { answerer: cfg?.model_answerer ?? 'stub' }

  try {
    const flow = build_flow(engine, models, { retriever: make_docs_retriever(args.docs), k: args.k })
    const outcome = await run(flow, { question: args.question })
    process.stdout.write(args.json ? render_json(outcome) : render_human(outcome))
    return 0
  } finally {
    await engine.dispose()
  }
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  },
)
