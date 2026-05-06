/**
 * Amplify entry.
 *
 * Builds the brief from CLI args, sets up the engine (Opus 4.7 via
 * claude_cli at `xhigh` effort by default), and runs the loop. Trajectory
 * logs go to `.runs/<run_id>/trajectory.jsonl`.
 *
 * Prerequisites:
 *   - `claude` CLI on PATH
 *   - authenticated session (`claude login`) — uses OAuth, no API key
 *
 * Usage:
 *   pnpm --filter @repo/example-amplify amplify
 *   pnpm --filter @repo/example-amplify amplify --metric quality --rounds 3 --candidates 2
 *   pnpm --filter @repo/example-amplify amplify --metric ./my-metric.ts
 *   pnpm --filter @repo/example-amplify amplify --effort max
 *
 * Env:
 *   AMPLIFY_EFFORT     "low" | "medium" | "high" | "xhigh" | "max" (default: "xhigh")
 *   AMPLIFY_RESEARCH   "web" | "offline" (default: "web")
 */

import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { create_engine, run, type EffortLevel } from '@repo/fascicle'
import { filesystem_logger, http_logger, tee_logger } from '@repo/fascicle/adapters'
import type { TrajectoryLogger } from '@repo/fascicle'

import { build_loop } from './loop.js'
import { load_metric } from './metric.js'
import type { Brief } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const TARGET_DIR = join(PACKAGE_ROOT, 'target')
const RUNS_DIR = join(PACKAGE_ROOT, '.runs')

const DEFAULT_TASK = [
  'Improve the log aggregator at target/src/log_aggregator.ts.',
  'It currently does one full file scan per service and rebuilds the regex on every call.',
  'Reduce the median wall-clock on a 5MB log without breaking any locked test.',
].join(' ')

const VALID_EFFORTS = new Set<string>([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

function is_effort_level(value: string): value is EffortLevel {
  return VALID_EFFORTS.has(value)
}

function parse_effort(value: string, source: string): EffortLevel {
  if (!is_effort_level(value)) {
    throw new Error(
      `${source}: "${value}" is not a valid effort level. Use one of: ${[...VALID_EFFORTS].join(', ')}`,
    )
  }
  return value
}

type CliArgs = {
  readonly metric: string
  readonly rounds: number
  readonly candidates: number
  readonly budget_min: number
  readonly task: string
  readonly effort: EffortLevel
}

function parse_args(argv: ReadonlyArray<string>): CliArgs {
  const args = [...argv]
  let metric = 'speed'
  let rounds = 5
  let candidates = 3
  let budget_min = 30
  let task = DEFAULT_TASK
  const env_effort = process.env['AMPLIFY_EFFORT']
  let effort: EffortLevel =
    env_effort !== undefined ? parse_effort(env_effort, 'AMPLIFY_EFFORT') : 'xhigh'

  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const next = args[i + 1]
    if (a === '--metric' && next !== undefined) {
      metric = next
      i++
    } else if (a === '--rounds' && next !== undefined) {
      rounds = Number.parseInt(next, 10)
      i++
    } else if (a === '--candidates' && next !== undefined) {
      candidates = Number.parseInt(next, 10)
      i++
    } else if (a === '--budget-min' && next !== undefined) {
      budget_min = Number.parseInt(next, 10)
      i++
    } else if (a === '--task' && next !== undefined) {
      task = next
      i++
    } else if (a === '--effort' && next !== undefined) {
      effort = parse_effort(next, '--effort')
      i++
    }
  }

  if (!Number.isInteger(rounds) || rounds < 1) {
    throw new Error(`--rounds must be a positive integer`)
  }
  if (!Number.isInteger(candidates) || candidates < 1) {
    throw new Error(`--candidates must be a positive integer`)
  }
  if (!Number.isFinite(budget_min) || budget_min < 1) {
    throw new Error(`--budget-min must be a positive number`)
  }
  return { metric, rounds, candidates, budget_min, task, effort }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function make_run_id(): string {
  const d = new Date()
  return `${String(d.getFullYear())}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

export async function run_amplify(argv: ReadonlyArray<string>): Promise<void> {
  const cli = parse_args(argv)

  const metric_spec = cli.metric.includes('/') || cli.metric.endsWith('.ts')
    ? resolve(cli.metric)
    : cli.metric
  const metric = await load_metric(metric_spec, TARGET_DIR)

  const run_id = make_run_id()
  const run_dir = join(RUNS_DIR, run_id)
  await mkdir(run_dir, { recursive: true })

  const brief: Brief = {
    task: cli.task,
    target_dir: TARGET_DIR,
    metric,
    run_id,
    run_dir,
  }

  const engine = create_engine({
    providers: { claude_cli: { auth_mode: 'oauth' } },
    defaults: { model: 'cli-opus', effort: cli.effort },
  })

  const file_sink = filesystem_logger({
    output_path: join(run_dir, 'trajectory.jsonl'),
  })
  const viewer_url = process.env['AMPLIFY_VIEWER_URL']
  const trajectory: TrajectoryLogger = viewer_url === undefined
    ? file_sink
    : tee_logger(
        file_sink,
        http_logger({
          url: viewer_url,
          on_error: (err) => {
            const message = err instanceof Error ? err.message : String(err)
            console.warn(`amplify: viewer push failed: ${message}`)
          },
        }),
      )
  if (viewer_url !== undefined) {
    console.log(`live-pushing trajectory to ${viewer_url}`)
  }

  const loop = build_loop({
    engine,
    candidates_per_round: cli.candidates,
    budget: {
      max_rounds: cli.rounds,
      max_wallclock_ms: cli.budget_min * 60_000,
      patience: Math.max(2, Math.ceil(cli.rounds / 3)),
    },
  })

  console.log(
    `amplify run ${run_id}: metric=${metric.name} rounds=${String(cli.rounds)} candidates=${String(cli.candidates)} effort=${cli.effort}`,
  )
  console.log(`run dir: ${run_dir}`)

  try {
    await run(loop, brief, { trajectory, install_signal_handlers: false })
    console.log(`✓ amplify done. trajectory: ${join(run_dir, 'trajectory.jsonl')}`)
  } finally {
    await engine.dispose()
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_amplify(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
