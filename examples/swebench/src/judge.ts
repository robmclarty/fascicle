/**
 * Two layers of judgment:
 *
 *   1. **In-bench judges** (cheap, run inside `bench`'s `Judge` slot): only
 *      check that the model emitted *something patch-shaped*. This is the
 *      smoke-time signal — it can't tell you the patch is correct, only that
 *      the agent didn't give up or hallucinate prose where a diff should be.
 *
 *   2. **Out-of-band eval** (`evaluate_with_sb_cli`): writes predictions to
 *      a JSONL and invokes the real SWE-bench harness. This is the only
 *      number that goes on the leaderboard. Kept separate because it
 *      requires Docker (or the hosted `sb-cli` cluster), takes minutes per
 *      instance, and shouldn't gate the inner iteration loop.
 *
 * The split lets you iterate on prompt/flow design with the cheap judges
 * locally, then sample-check resolution rate with the real eval before
 * committing to a baseline.
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { step } from '@repo/fascicle'
import type { Judge } from '@repo/fascicle'
import { count_files_touched, is_nonempty_patch, looks_like_unified_diff } from './diff.js'
import type { EvalRecord, EvalReport, Prediction, SweBenchInstance } from './types.js'

export const judge_patch_nonempty: Judge<SweBenchInstance, Prediction> = step(
  'judge_patch_nonempty',
  ({ output }) => {
    const ok = is_nonempty_patch(output.model_patch)
    return { score: ok ? 1 : 0, reason: ok ? 'patch present' : 'empty patch' }
  },
)

export const judge_patch_shape: Judge<SweBenchInstance, Prediction> = step(
  'judge_patch_shape',
  ({ output }) => {
    const ok = looks_like_unified_diff(output.model_patch)
    return {
      score: ok ? 1 : 0,
      reason: ok
        ? `unified diff (${String(count_files_touched(output.model_patch))} files)`
        : 'not a unified diff',
    }
  },
)

export async function write_predictions(
  path: string,
  predictions: ReadonlyArray<Prediction>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const lines = predictions.map((p) => JSON.stringify(p)).join('\n')
  await writeFile(path, `${lines}\n`)
}

export type EvalOptions = {
  readonly predictions_path: string
  readonly run_id: string
  readonly dataset: 'swe-bench-verified' | 'swe-bench-lite' | 'swe-bench-full'
  readonly abort: AbortSignal
  readonly report_path?: string
}

/**
 * Shell out to `sb-cli submit` and parse its report. Returns undefined if
 * `sb-cli` is not installed or the call fails — the caller decides whether
 * a missing eval is fatal.
 */
export async function evaluate_with_sb_cli(opts: EvalOptions): Promise<EvalReport | undefined> {
  const argv: ReadonlyArray<string> = [
    'submit',
    opts.dataset,
    opts.run_id,
    '--predictions',
    opts.predictions_path,
    '--output',
    opts.report_path ?? '.runs/swebench/report.json',
  ]

  const result = await spawn_capture('sb-cli', argv, opts.abort)
  if (result === undefined) return undefined
  if (result.exit_code !== 0) {
    console.error(`sb-cli exited ${String(result.exit_code)}\n${result.stderr}`)
    return undefined
  }

  const report_file = opts.report_path ?? '.runs/swebench/report.json'
  try {
    const raw = await readFile(report_file, 'utf8')
    return parse_eval_report(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`could not read sb-cli report at ${report_file}: ${message}`)
    return undefined
  }
}

function get_string_array(obj: object, key: 'resolved_ids' | 'all_ids'): ReadonlyArray<string> {
  if (!(key in obj)) return []
  const value: unknown = Reflect.get(obj, key)
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string') out.push(item)
  }
  return out
}

function parse_eval_report(raw: string): EvalReport | undefined {
  const data: unknown = JSON.parse(raw)
  if (data === null || typeof data !== 'object') return undefined
  const resolved_ids = get_string_array(data, 'resolved_ids')
  const all_ids = get_string_array(data, 'all_ids')
  const records: EvalRecord[] = all_ids.map((instance_id) => {
    const resolved = resolved_ids.includes(instance_id)
    return { instance_id, resolved, summary: resolved ? 'resolved' : 'unresolved' }
  })
  const total = records.length
  const resolved = records.filter((r) => r.resolved).length
  return {
    total,
    resolved,
    resolution_rate: total === 0 ? 0 : resolved / total,
    records,
  }
}

type SpawnResult = { readonly stdout: string; readonly stderr: string; readonly exit_code: number }

async function spawn_capture(
  command: string,
  argv: ReadonlyArray<string>,
  abort: AbortSignal,
): Promise<SpawnResult | undefined> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, [...argv], { signal: abort })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`${command} not available: ${message}`)
      resolve(undefined)
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (err) => {
      console.error(`${command} failed: ${err.message}`)
      resolve(undefined)
    })
    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exit_code: code ?? -1,
      })
    })
  })
}
