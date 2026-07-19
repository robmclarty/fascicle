/**
 * change-triage CLI entry: the shell.
 *
 * Reads a unified diff, runs the flow once, writes artifacts, exits.
 *
 *   pnpm --filter @repo/example-change-triage triage:stub
 *   tsx src/main.ts --diff <path> [--provider anthropic|ollama|claude_cli]
 *   tsx src/main.ts --diff <path> --fail-on high     # CI gate: exit 1 at/above band
 *
 * All side effects happen after `run` returns, keyed off the typed report:
 * a markdown report and result.json under `.runs/<run-id>/`, plus the report
 * on stdout. The trajectory adapter is injected here and only here.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { run } from 'fascicle'
import { filesystem_logger } from 'fascicle/adapters'

import {
  create_app_engine,
  make_stub_engine,
  read_engine_env,
  type Provider,
} from './engine.js'
import { band_at_or_above } from './floor.js'
import { build_flow } from './flow.js'
import { render_report } from './render.js'
import { severity_schema, type Band } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNS_DIR = join(HERE, '..', '.runs')

type CliArgs = {
  readonly diff: string
  readonly stub: boolean
  readonly provider?: Provider
  readonly fail_on?: Band
}

function parse_argv(argv: ReadonlyArray<string>): CliArgs {
  const args = argv.slice(2)
  let diff: string | undefined
  let stub = false
  let provider: Provider | undefined
  let fail_on: Band | undefined
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === '--stub') stub = true
    else if (a === '--diff') {
      diff = args[i + 1]
      i += 1
    } else if (a === '--provider') {
      const raw = args[i + 1]
      const found = (['anthropic', 'ollama', 'claude_cli'] as const).find((p) => p === raw)
      if (found === undefined) throw new Error(`--provider must be one of anthropic, ollama, claude_cli`)
      provider = found
      i += 1
    } else if (a === '--fail-on') {
      fail_on = severity_schema.parse(args[i + 1])
      i += 1
    }
  }
  if (diff === undefined) {
    throw new Error('Usage: tsx src/main.ts --diff <path> [--stub] [--provider <name>] [--fail-on <band>]')
  }
  const out: CliArgs = { diff, stub }
  if (provider !== undefined) Object.assign(out, { provider })
  if (fail_on !== undefined) Object.assign(out, { fail_on })
  return out
}

const STUB_ASSESSMENT = {
  score: 20,
  confidence: 'medium',
  summary: 'Stubbed assessment: the deterministic signals below carry the real risk story.',
  factors: [],
}

async function main(): Promise<number> {
  const args = parse_argv(process.argv)
  const diff = await readFile(args.diff, 'utf8')
  const input = { label: basename(args.diff), diff }

  const run_id = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const run_dir = join(RUNS_DIR, run_id)
  await mkdir(run_dir, { recursive: true })

  const engine = args.stub
    ? make_stub_engine([{ match_system_prefix: 'change-triage/assessor', content: STUB_ASSESSMENT }])
    : create_app_engine(read_engine_env(process.env, args.provider))
  const cfg = args.stub ? { model_assessor: 'stub' } : read_engine_env(process.env, args.provider)

  try {
    const flow = build_flow(engine, { assessor: cfg.model_assessor })
    const report = await run(flow, input, {
      trajectory: filesystem_logger({ output_path: join(run_dir, 'trajectory.jsonl') }),
    })

    const markdown = render_report(report)
    await writeFile(join(run_dir, 'REPORT.md'), markdown, 'utf8')
    await writeFile(join(run_dir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(markdown)
    process.stdout.write(`\nArtifacts: ${run_dir}\n`)

    if (args.fail_on !== undefined && band_at_or_above(report.band, args.fail_on)) {
      process.stdout.write(`Failing: band ${report.band} is at or above --fail-on ${args.fail_on}\n`)
      return 1
    }
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
