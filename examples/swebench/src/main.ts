/**
 * SWE-bench smoke harness driver.
 *
 * Builds the engine config, the per-case sandbox factory, and the solve
 * flow, then drives `bench` over the vendored 5-instance fixture. Emits:
 *   - `.runs/swebench/<run_id>/predictions.jsonl` — the input to sb-cli
 *   - `.runs/swebench/<run_id>/trajectories/*.jsonl` — one per case
 *   - `.runs/swebench/<run_id>/report.json` — the bench report
 *
 * Providers (set with `SWEBENCH_PROVIDER`):
 *   - `claude_cli` (default): OAuth via the local `claude` binary, no API
 *     key, uses the CLI's built-in Read/Write/Edit/Bash. Each case gets a
 *     fresh engine pinned to the sandbox workdir.
 *   - `anthropic`: requires `ANTHROPIC_API_KEY`; the flow injects our
 *     Sandbox-bound tools on every model call.
 *
 * If `SWEBENCH_RUN_EVAL=1` and `sb-cli` is on PATH, the driver shells out
 * after bench completes, parses the eval report, and prints resolution rate.
 *
 * Usage:
 *   pnpm --filter @repo/example-swebench swebench
 *   SWEBENCH_SANDBOX=local pnpm --filter @repo/example-swebench swebench
 *   SWEBENCH_PROVIDER=anthropic ANTHROPIC_API_KEY=... pnpm --filter @repo/example-swebench swebench
 *   SWEBENCH_INSTANCE=astropy__astropy-12907 pnpm --filter @repo/example-swebench swebench
 *   SWEBENCH_RUN_EVAL=1 pnpm --filter @repo/example-swebench swebench
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bench, create_engine } from '@repo/fascicle'
import type { BenchReport, EffortLevel, Engine } from '@repo/fascicle'

import { SMOKE_INSTANCES } from './instances.js'
import { solve_instance } from './flow.js'
import type { SolveConfig } from './flow.js'
import {
  evaluate_with_sb_cli,
  judge_patch_nonempty,
  judge_patch_shape,
  write_predictions,
} from './judge.js'
import { resolve_sandbox_factory } from './sandbox.js'
import type { Prediction, SweBenchInstance } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const RUNS_DIR = join(PACKAGE_ROOT, '.runs')

const VALID_EFFORTS: ReadonlySet<EffortLevel> = new Set([
  'none', 'low', 'medium', 'high', 'xhigh', 'max',
])

function is_effort(value: string): value is EffortLevel {
  return (VALID_EFFORTS as ReadonlySet<string>).has(value)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function make_run_id(): string {
  const d = new Date()
  return `${String(d.getFullYear())}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

function predictions_from_report(report: BenchReport<SweBenchInstance, Prediction>): ReadonlyArray<Prediction> {
  const predictions: Prediction[] = []
  for (const case_result of report.cases) {
    if (!case_result.ok || case_result.output === undefined) continue
    predictions.push(case_result.output)
  }
  return predictions
}

type ProviderChoice =
  | { readonly kind: 'claude_cli'; readonly model: string; readonly effort: EffortLevel; readonly shared_engine?: undefined }
  | { readonly kind: 'anthropic'; readonly model: string; readonly shared_engine: Engine }

function resolve_provider(): ProviderChoice {
  const raw = (process.env['SWEBENCH_PROVIDER'] ?? 'claude_cli').toLowerCase()
  if (raw === 'claude_cli') {
    const model = process.env['SWEBENCH_MODEL'] ?? 'cli-sonnet'
    const effort_raw = process.env['SWEBENCH_EFFORT'] ?? 'medium'
    if (!is_effort(effort_raw)) {
      throw new Error(
        `SWEBENCH_EFFORT="${effort_raw}" is not a valid effort level (none|low|medium|high|xhigh|max).`,
      )
    }
    return { kind: 'claude_cli', model, effort: effort_raw }
  }
  if (raw === 'anthropic') {
    const api_key = process.env['ANTHROPIC_API_KEY'] ?? ''
    if (api_key.length === 0) {
      throw new Error('SWEBENCH_PROVIDER=anthropic requires ANTHROPIC_API_KEY.')
    }
    const model = process.env['SWEBENCH_MODEL'] ?? 'sonnet'
    const shared_engine = create_engine({
      providers: { anthropic: { api_key } },
      defaults: { model },
    })
    return { kind: 'anthropic', model, shared_engine }
  }
  throw new Error(`SWEBENCH_PROVIDER="${raw}" not recognized. Use 'claude_cli' or 'anthropic'.`)
}

export async function run_swebench_smoke(): Promise<void> {
  const provider = resolve_provider()

  const run_id = make_run_id()
  const run_dir = join(RUNS_DIR, run_id)
  const trajectory_dir = join(run_dir, 'trajectories')
  const predictions_path = join(run_dir, 'predictions.jsonl')
  const report_path = join(run_dir, 'report.json')
  await mkdir(trajectory_dir, { recursive: true })

  const sandbox_factory = resolve_sandbox_factory(process.env['SWEBENCH_SANDBOX'])
  const model_name_or_path =
    process.env['SWEBENCH_MODEL_NAME'] ?? `fascicle-smoke-${provider.kind}-${provider.model}`

  const solve_config: SolveConfig = provider.kind === 'claude_cli'
    ? {
        provider: 'claude_cli',
        model: provider.model,
        effort: provider.effort,
        sandbox_factory,
        model_name_or_path,
      }
    : {
        provider: 'anthropic',
        engine: provider.shared_engine,
        model: provider.model,
        sandbox_factory,
        model_name_or_path,
      }
  const flow = solve_instance(solve_config)

  const filter = process.env['SWEBENCH_INSTANCE']
  const selected = filter === undefined || filter.length === 0
    ? SMOKE_INSTANCES
    : SMOKE_INSTANCES.filter((i) => i.instance_id === filter)
  if (selected.length === 0) {
    const known = SMOKE_INSTANCES.map((i) => i.instance_id).join(', ')
    console.error(`SWEBENCH_INSTANCE="${filter ?? ''}" matched no vendored instance. Known: ${known}`)
    process.exit(1)
  }
  const cases = selected.map((instance) => ({
    id: instance.instance_id,
    input: instance,
  }))

  console.log(
    `swebench smoke run ${run_id}: ${String(cases.length)} case(s), ` +
      `provider=${provider.kind} model=${provider.model} ` +
      `sandbox=${process.env['SWEBENCH_SANDBOX'] ?? 'noop'}`,
  )
  console.log(`run dir: ${run_dir}`)

  let report: BenchReport<SweBenchInstance, Prediction>
  try {
    report = await bench<SweBenchInstance, Prediction>(
      flow,
      cases,
      { patch_nonempty: judge_patch_nonempty, patch_shape: judge_patch_shape },
      {
        concurrency: 1,
        trajectory_dir,
        run_id,
      },
    )
  } finally {
    if (provider.kind === 'anthropic') await provider.shared_engine.dispose()
  }

  await writeFile(report_path, `${JSON.stringify(report, null, 2)}\n`)
  const predictions = predictions_from_report(report)
  await write_predictions(predictions_path, predictions)

  console.log('')
  console.log(`flow completion: ${report.summary.pass_rate.toFixed(2)}`)
  console.log(`patch shape:     ${(report.summary.mean_scores['patch_shape'] ?? 0).toFixed(2)}`)
  console.log(`total cost:      $${report.summary.total_cost_usd.toFixed(4)}`)
  console.log(`predictions:     ${predictions_path}`)

  if (process.env['SWEBENCH_RUN_EVAL'] !== '1') {
    console.log('\nskipping sb-cli eval (set SWEBENCH_RUN_EVAL=1 to enable).')
    return
  }

  console.log('\nrunning sb-cli evaluation...')
  const eval_report = await evaluate_with_sb_cli({
    predictions_path,
    run_id,
    dataset: 'swe-bench-verified',
    abort: AbortSignal.timeout(60 * 60_000),
    report_path: join(run_dir, 'eval.json'),
  })

  if (eval_report === undefined) {
    console.error('sb-cli eval did not produce a report; check sb-cli setup.')
    process.exit(2)
  }

  console.log(`resolved: ${String(eval_report.resolved)}/${String(eval_report.total)} (${(eval_report.resolution_rate * 100).toFixed(1)}%)`)
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_swebench_smoke().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
