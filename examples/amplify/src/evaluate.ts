/**
 * Cascade evaluator: syntax → gate → measure.
 *
 * First failure short-circuits — a failing candidate never burns budget on
 * the next stage. This is the OpenEvolve / Stryker discipline: cheap
 * filters before expensive ones.
 *
 *   Stage 1 (syntax)  — `tsc --noEmit` against the candidate file. Free,
 *                       catches obvious garbage.
 *   Stage 2 (gate)    — `metric.gate.command`. Locked regression suite;
 *                       non-zero exit = candidate dies. This is the load-
 *                       bearing defense against reward hacking.
 *   Stage 3 (measure) — `metric.score(impl_path)`. The number that drives
 *                       selection.
 */

import { spawn } from 'node:child_process'

import { swap_in } from './apply.js'
import type { Metric, Score } from './types.js'

const SYNTAX_TIMEOUT_MS = 30_000

type SpawnResult = {
  readonly stdout: string
  readonly stderr: string
  readonly exit_code: number
}

function run_command(
  cmd: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string>,
  timeout_ms: number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const head = cmd[0]
    const tail = cmd.slice(1)
    if (head === undefined) {
      reject(new Error('run_command: empty command'))
      return
    }
    const proc = spawn(head, tail, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeout_ms)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (b: Buffer) => {
      stdout += b.toString()
    })
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString()
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exit_code: code ?? -1 })
    })
  })
}

const TAIL_BYTES = 2_000
function trim_to_tail(buf: string): string {
  return buf.length <= TAIL_BYTES ? buf : `…\n${buf.slice(buf.length - TAIL_BYTES)}`
}

async function check_syntax(_impl_path: string, cwd: string): Promise<SpawnResult> {
  return run_command(
    ['pnpm', 'exec', 'tsc', '--noEmit', '-p', '.'],
    cwd,
    {},
    SYNTAX_TIMEOUT_MS,
  )
}

export async function evaluate_candidate(
  metric: Metric,
  candidate_content: string,
  failure_score: number,
): Promise<Score> {
  const restore = await swap_in(metric.mutable_path, candidate_content)
  try {
    const syntax = await check_syntax(metric.mutable_path, metric.gate.cwd)
    if (syntax.exit_code !== 0) {
      return {
        value: failure_score,
        accepted: false,
        stage_failed: 'syntax',
        tail: trim_to_tail(syntax.stdout + syntax.stderr),
      }
    }

    const expected_exit = metric.gate.expected_exit ?? 0
    const gate = await run_command(
      metric.gate.command,
      metric.gate.cwd,
      metric.gate.env ?? {},
      metric.gate.timeout_ms ?? 60_000,
    )
    if (gate.exit_code !== expected_exit) {
      return {
        value: failure_score,
        accepted: false,
        stage_failed: 'gate',
        tail: trim_to_tail(gate.stdout + gate.stderr),
      }
    }

    let value: number
    try {
      value = await metric.score(metric.mutable_path)
    } catch (err) {
      return {
        value: failure_score,
        accepted: false,
        stage_failed: 'measure',
        tail: err instanceof Error ? err.message : String(err),
      }
    }

    return { value, accepted: true }
  } finally {
    await restore()
  }
}

export function failure_score_for(direction: 'minimize' | 'maximize'): number {
  return direction === 'minimize' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
}
