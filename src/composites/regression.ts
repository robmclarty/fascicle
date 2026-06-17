/**
 * regression_compare: diff two BenchReports for regressions.
 *
 * The contract: given a `current` report and a `baseline` report, produce a
 * `RegressionReport` whose `ok` flag is false when any tracked metric got
 * worse beyond a threshold. The function does NOT short-circuit on first
 * failure — every metric and every per-case delta is computed so callers can
 * print or assert against the whole report.
 *
 * Tracked metrics:
 *   - pass_rate              (any drop is a regression by default)
 *   - mean_scores.<name>     (per judge; any drop is a regression by default)
 *   - total_cost_usd         (a relative cost increase above cost_threshold
 *                             counts as a regression; default 10%)
 *
 * Baselines are plain JSON, written via `write_baseline` and read via
 * `read_baseline`. They live wherever the caller decides — typically
 * `bench/<flow>/baseline.json`, checked into git per spec/eval.md §3.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { BenchReport, CaseResult, Score } from './bench.js'

export type RegressionDelta = {
  readonly metric: string
  readonly baseline: number
  readonly current: number
  readonly delta: number
  readonly is_regression: boolean
}

export type PerCaseDelta = {
  readonly case_id: string
  readonly baseline?: CaseResult
  readonly current?: CaseResult
  readonly score_deltas: Record<string, number>
  readonly cost_delta: number
  readonly is_regression: boolean
}

export type RegressionReport = {
  readonly ok: boolean
  readonly deltas: ReadonlyArray<RegressionDelta>
  readonly per_case: ReadonlyArray<PerCaseDelta>
}

export type RegressionCompareOptions = {
  readonly score_threshold?: number
  readonly cost_threshold?: number
}

export function regression_compare(
  current: BenchReport,
  baseline: BenchReport,
  options: RegressionCompareOptions = {},
): RegressionReport {
  const score_threshold = options.score_threshold ?? 0
  const cost_threshold = options.cost_threshold ?? 0.1

  const deltas: RegressionDelta[] = []

  const pass_delta = current.summary.pass_rate - baseline.summary.pass_rate
  deltas.push({
    metric: 'pass_rate',
    baseline: baseline.summary.pass_rate,
    current: current.summary.pass_rate,
    delta: pass_delta,
    is_regression: pass_delta < -score_threshold,
  })

  const judge_names = collect_judge_names(current, baseline)
  for (const name of judge_names) {
    const c = current.summary.mean_scores[name] ?? 0
    const b = baseline.summary.mean_scores[name] ?? 0
    const d = c - b
    deltas.push({
      metric: `mean_scores.${name}`,
      baseline: b,
      current: c,
      delta: d,
      is_regression: d < -score_threshold,
    })
  }

  const cb = baseline.summary.total_cost_usd
  const cc = current.summary.total_cost_usd
  const cost_delta = cc - cb
  const cost_ratio = cb === 0 ? (cc > 0 ? Infinity : 0) : cost_delta / cb
  deltas.push({
    metric: 'total_cost_usd',
    baseline: cb,
    current: cc,
    delta: cost_delta,
    is_regression: cost_ratio > cost_threshold,
  })

  const per_case = compute_per_case(current, baseline, score_threshold, cost_threshold)
  const ok = !deltas.some((d) => d.is_regression) && !per_case.some((c) => c.is_regression)

  return { ok, deltas, per_case }
}

function compute_per_case(
  current: BenchReport,
  baseline: BenchReport,
  score_threshold: number,
  cost_threshold: number,
): PerCaseDelta[] {
  const by_id_current = index_by_case_id(current.cases)
  const by_id_baseline = index_by_case_id(baseline.cases)
  const all_ids = new Set<string>([...by_id_current.keys(), ...by_id_baseline.keys()])

  const out: PerCaseDelta[] = []
  for (const id of all_ids) {
    const c = by_id_current.get(id)
    const b = by_id_baseline.get(id)
    const score_deltas: Record<string, number> = {}
    let any_score_regression = false
    const judge_names = new Set<string>([
      ...Object.keys(c?.scores ?? {}),
      ...Object.keys(b?.scores ?? {}),
    ])
    for (const name of judge_names) {
      const c_score = score_value(c?.scores[name])
      const b_score = score_value(b?.scores[name])
      const delta = c_score - b_score
      score_deltas[name] = delta
      if (delta < -score_threshold) any_score_regression = true
    }
    const cost_delta = (c?.cost_usd ?? 0) - (b?.cost_usd ?? 0)
    const cost_ratio_regression =
      b?.cost_usd !== undefined && b.cost_usd > 0
        ? cost_delta / b.cost_usd > cost_threshold
        : (c?.cost_usd ?? 0) > 0 && (b?.cost_usd ?? 0) === 0 && cost_threshold < Infinity
    const ok_regression = b?.ok === true && c?.ok !== true
    out.push({
      case_id: id,
      ...(b !== undefined ? { baseline: b } : {}),
      ...(c !== undefined ? { current: c } : {}),
      score_deltas,
      cost_delta,
      is_regression: any_score_regression || cost_ratio_regression || ok_regression,
    })
  }
  return out
}

function score_value(s: unknown): number {
  if (s === undefined || s === null) return 0
  if (typeof s === 'number') return Number.isFinite(s) ? s : 0
  if (typeof s === 'object' && 'score' in s) {
    const v = (s as Record<string, unknown>)['score']
    return typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  return 0
}

function index_by_case_id<I, O, S>(
  cases: ReadonlyArray<CaseResult<I, O, S>>,
): Map<string, CaseResult<I, O, S>> {
  const m = new Map<string, CaseResult<I, O, S>>()
  for (const c of cases) m.set(c.case_id, c)
  return m
}

function collect_judge_names(a: BenchReport, b: BenchReport): string[] {
  const names = new Set<string>([
    ...Object.keys(a.summary.mean_scores),
    ...Object.keys(b.summary.mean_scores),
  ])
  return [...names].toSorted()
}

export async function read_baseline(path: string): Promise<BenchReport> {
  const text = await readFile(path, 'utf8')
  const parsed: unknown = JSON.parse(text)
  validate_report(parsed, path)
  return parsed
}

export async function write_baseline(path: string, report: BenchReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

function validate_report(value: unknown, path: string): asserts value is BenchReport {
  if (value === null || typeof value !== 'object') {
    throw new Error(`baseline at ${path} is not an object`)
  }
  const v = value as Partial<BenchReport>
  if (typeof v.flow_name !== 'string' || typeof v.run_id !== 'string') {
    throw new Error(`baseline at ${path} missing flow_name/run_id`)
  }
  if (!Array.isArray(v.cases) || typeof v.summary !== 'object' || v.summary === null) {
    throw new Error(`baseline at ${path} missing cases/summary`)
  }
}

// Runtime-side type re-export: regression consumers want both the diff types
// and the underlying CaseResult/Score shapes from one import.
export type { Score } from './bench.js'
