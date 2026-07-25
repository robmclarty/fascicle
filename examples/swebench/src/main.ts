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

import { bench } from 'fascicle'
import type { BenchReport, Engine } from 'fascicle'

import { create_app_engine, read_engine_env } from './engine.js'
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
import type { SandboxFactory } from './sandbox.js'
import type { Prediction, SweBenchInstance } from './types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const RUNS_DIR = join(PACKAGE_ROOT, '.runs')

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

/**
 * Build the solve config, plus the engine the caller must dispose.
 *
 * The API path shares one engine across every case; the CLI path builds one per
 * case inside the flow, because each needs its own sandbox cwd. Returning both
 * together keeps "who owns disposal" answerable at the call site.
 */
function build_solve_config(
  cfg: ReturnType<typeof read_engine_env>,
  sandbox_factory: SandboxFactory,
  model_name_or_path: string,
): { readonly config: SolveConfig; readonly shared_engine?: Engine } {
  if (cfg.provider === 'claude_cli') {
    return {
      config: {
        provider: 'claude_cli',
        model: cfg.model,
        effort: cfg.effort,
        sandbox_factory,
        model_name_or_path,
      },
    }
  }
  const shared_engine = create_app_engine(cfg)
  return {
    config: {
      provider: 'anthropic',
      engine: shared_engine,
      model: cfg.model,
      sandbox_factory,
      model_name_or_path,
    },
    shared_engine,
  }
}

export async function run_swebench_smoke(): Promise<void> {
  const cfg = read_engine_env()

  const run_id = make_run_id()
  const run_dir = join(RUNS_DIR, run_id)
  const trajectory_dir = join(run_dir, 'trajectories')
  const predictions_path = join(run_dir, 'predictions.jsonl')
  const report_path = join(run_dir, 'report.json')
  await mkdir(trajectory_dir, { recursive: true })

  const sandbox_factory = resolve_sandbox_factory(process.env['SWEBENCH_SANDBOX'])
  const model_name_or_path =
    process.env['SWEBENCH_MODEL_NAME'] ?? `fascicle-smoke-${cfg.provider}-${cfg.model}`

  const { config: solve_config, shared_engine } = build_solve_config(
    cfg,
    sandbox_factory,
    model_name_or_path,
  )
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
      `provider=${cfg.provider} model=${cfg.model} ` +
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
    await shared_engine?.dispose()
  }

  await writeFile(report_path, `${JSON.stringify(report, null, 2)}\n`)
  const predictions = predictions_from_report(report)
  await write_predictions(predictions_path, predictions)

  console.log('')
  console.log(`flow completion: ${report.summary.pass_rate.toFixed(2)}`)
  console.log(`patch shape:     ${(report.summary.mean_scores['patch_shape'] ?? 0).toFixed(2)}`)
  console.log(`total cost:      $${report.summary.total_cost_usd.toFixed(4)}`)
  console.log(`predictions:     ${predictions_path}`)

  const errored = report.cases.filter((c) => !c.ok)
  if (errored.length > 0 && errored.length === report.cases.length) {
    const messages = [...new Set(errored.map((c) => c.error ?? 'unknown error'))]
    console.error(`\nall ${String(report.cases.length)} case(s) errored:`)
    for (const message of messages) console.error(`  ${message}`)
    process.exit(1)
  }
  if (errored.length > 0) {
    console.error(
      `\nwarning: ${String(errored.length)}/${String(report.cases.length)} case(s) errored; see ${report_path}`,
    )
  }

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
