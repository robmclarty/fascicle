/**
 * bench: run a flow against a fixture set, score each result, return a report.
 *
 * Online counterpart to `learn`: where `learn` reflects on past trajectories
 * after the fact, `bench` runs the flow live against fresh `cases`, judges
 * each output, and produces a `BenchReport` you can compare against a
 * committed baseline via `regression_compare`.
 *
 * Each case becomes one `run(flow, case.input, ...)`. Per-case observability:
 *   - `trajectory_dir` writes `${dir}/${case.id}.jsonl` via filesystem_logger
 *   - `live_url` POSTs each event via http_logger to a viewer's /api/ingest
 *   - both can be combined; bench tees them with an internal cost tracker
 *
 * Cost is tracked per-case in-process by intercepting `kind: 'cost'` events
 * on the trajectory pipeline. The cost number matches what would be on disk
 * even when no trajectory_dir is set.
 *
 * Judges run as Steps after each case, with the same trajectory logger so
 * judge spans land in the case's trajectory file (or push). A judge that
 * throws or returns undefined abstains: the entry is omitted from
 * `case.scores` and the case does not contribute to that judge's mean.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '@repo/core'
import type { Step, TrajectoryEvent, TrajectoryLogger } from '@repo/core'
import { filesystem_logger, http_logger, tee_logger } from '@repo/observability'

export type Score = { readonly score: number; readonly reason?: string }

export type BenchCase<I> = {
  readonly id: string
  readonly input: I
  readonly meta?: Readonly<Record<string, unknown>>
}

export type JudgeArgs<I, O> = {
  readonly input: I
  readonly output: O
  readonly meta?: Readonly<Record<string, unknown>>
}

export type Judge<I, O, S = Score> = Step<JudgeArgs<I, O>, S | undefined>

export type CaseResult<I = unknown, O = unknown, S = Score> = {
  readonly case_id: string
  readonly ok: boolean
  readonly output?: O
  readonly error?: string
  readonly scores: Record<string, S>
  readonly duration_ms: number
  readonly cost_usd: number
  readonly trajectory_path?: string
  readonly _input?: I
}

export type BenchSummary = {
  readonly pass_rate: number
  readonly mean_scores: Record<string, number>
  readonly total_duration_ms: number
  readonly total_cost_usd: number
  readonly mean_cost_usd: number
}

export type BenchReport<I = unknown, O = unknown, S = Score> = {
  readonly flow_name: string
  readonly run_id: string
  readonly cases: ReadonlyArray<CaseResult<I, O, S>>
  readonly summary: BenchSummary
}

export type BenchOptions = {
  readonly concurrency?: number
  readonly on_case?: (result: CaseResult) => void
  readonly trajectory_dir?: string
  readonly live_url?: string
  readonly run_id?: string
  readonly install_signal_handlers?: boolean
}

export async function bench<I, O, S = Score>(
  flow: Step<I, O>,
  cases: ReadonlyArray<BenchCase<I>>,
  judges: Record<string, Judge<I, O, S>>,
  options: BenchOptions = {},
): Promise<BenchReport<I, O, S>> {
  const run_id = options.run_id ?? `bench-${String(Date.now())}-${random_suffix()}`
  const flow_name = describe_flow_name(flow)
  const concurrency = resolve_concurrency(options.concurrency, cases.length)
  const install_signal_handlers = options.install_signal_handlers ?? false

  if (options.trajectory_dir !== undefined) {
    await mkdir(options.trajectory_dir, { recursive: true })
  }

  const judge_entries = Object.entries(judges)

  const run_one = async (bc: BenchCase<I>): Promise<CaseResult<I, O, S>> => {
    const trajectory_path =
      options.trajectory_dir === undefined
        ? undefined
        : join(options.trajectory_dir, `${bc.id}.jsonl`)
    const sinks: TrajectoryLogger[] = []
    if (trajectory_path !== undefined) {
      sinks.push(filesystem_logger({ output_path: trajectory_path }))
    }
    if (options.live_url !== undefined) {
      sinks.push(http_logger({ url: options.live_url }))
    }
    const cost_tracker = create_cost_tracker()
    const case_logger: TrajectoryLogger =
      sinks.length === 0
        ? cost_tracker.logger
        : tee_logger(...sinks, cost_tracker.logger)

    const start = Date.now()
    let output: O | undefined
    let error: string | undefined
    let ok = false
    try {
      output = await run(flow, bc.input, {
        trajectory: case_logger,
        install_signal_handlers,
      })
      ok = true
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      ok = false
    }

    const scores: Record<string, S> = {}
    if (ok && output !== undefined) {
      const judge_input: JudgeArgs<I, O> = bc.meta === undefined
        ? { input: bc.input, output }
        : { input: bc.input, output, meta: bc.meta }
      for (const [name, judge] of judge_entries) {
        let raw: unknown
        try {
          // oxlint-disable-next-line no-await-in-loop
          raw = await run(judge, judge_input, {
            trajectory: case_logger,
            install_signal_handlers,
          })
        } catch {
          continue
        }
        const normalized = normalize_score(raw)
        if (normalized === undefined) continue
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        scores[name] = normalized as S
      }
    }

    const duration_ms = Date.now() - start
    const result: CaseResult<I, O, S> = {
      case_id: bc.id,
      ok,
      ...(output !== undefined ? { output } : {}),
      ...(error !== undefined ? { error } : {}),
      scores,
      duration_ms,
      cost_usd: cost_tracker.total(),
      ...(trajectory_path !== undefined ? { trajectory_path } : {}),
    }
    if (options.on_case) {
      // The on_case callback receives the lossy-typed shape — bench's S is
      // generic but the callback hook is a single concrete signature.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      options.on_case(result as unknown as CaseResult)
    }
    return result
  }

  const cases_out = await run_with_concurrency(cases, concurrency, run_one)
  const summary = summarize(cases_out, judge_entries.map(([n]) => n))

  return {
    flow_name,
    run_id,
    cases: cases_out,
    summary,
  }
}

function summarize<I, O, S>(
  cases: ReadonlyArray<CaseResult<I, O, S>>,
  judge_names: ReadonlyArray<string>,
): BenchSummary {
  const total_duration_ms = cases.reduce((acc, c) => acc + c.duration_ms, 0)
  const total_cost_usd = cases.reduce((acc, c) => acc + c.cost_usd, 0)
  const ok_count = cases.filter((c) => c.ok).length
  const pass_rate = cases.length === 0 ? 0 : ok_count / cases.length
  const mean_cost_usd = cases.length === 0 ? 0 : total_cost_usd / cases.length

  const mean_scores: Record<string, number> = {}
  for (const name of judge_names) {
    let sum = 0
    let count = 0
    for (const c of cases) {
      const n = score_value_of(c.scores[name])
      if (n === undefined) continue
      sum += n
      count += 1
    }
    if (count > 0) mean_scores[name] = sum / count
  }

  return {
    pass_rate,
    mean_scores,
    total_duration_ms,
    total_cost_usd,
    mean_cost_usd,
  }
}

export function normalize_score(raw: unknown): Score | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { score: raw } : undefined
  }
  if (typeof raw === 'object' && 'score' in raw) {
    const r = raw as { score: unknown; reason?: unknown }
    if (typeof r.score !== 'number' || !Number.isFinite(r.score)) return undefined
    if (r.reason !== undefined && typeof r.reason !== 'string') {
      return { score: r.score }
    }
    return r.reason === undefined ? { score: r.score } : { score: r.score, reason: r.reason }
  }
  return undefined
}

function score_value_of(s: unknown): number | undefined {
  if (s === undefined || s === null) return undefined
  if (typeof s === 'number') return Number.isFinite(s) ? s : undefined
  if (typeof s === 'object' && 'score' in s) {
    const raw = (s as Record<string, unknown>)['score']
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
  }
  return undefined
}

function create_cost_tracker(): {
  readonly logger: TrajectoryLogger
  readonly total: () => number
} {
  let total = 0
  return {
    total: () => total,
    logger: {
      record: (event: TrajectoryEvent) => {
        if (event.kind !== 'cost') return
        const e: Record<string, unknown> = event
        const value = e['total_usd']
        if (typeof value === 'number' && Number.isFinite(value)) total += value
      },
      start_span: (name) => `cost-tracker:${name}`,
      end_span: () => {},
    },
  }
}

async function run_with_concurrency<t, r>(
  items: ReadonlyArray<t>,
  limit: number,
  fn: (item: t) => Promise<r>,
): Promise<r[]> {
  if (items.length === 0) return []
  if (limit >= items.length) {
    return Promise.all(items.map((it) => fn(it)))
  }
  const results: r[] = Array.from({ length: items.length })
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = next
      next += 1
      if (idx >= items.length) return
      const item = items[idx]
      if (item === undefined) continue
      // oxlint-disable-next-line no-await-in-loop
      results[idx] = await fn(item)
    }
  }
  const workers: Promise<void>[] = []
  for (let i = 0; i < limit; i += 1) workers.push(worker())
  await Promise.all(workers)
  return results
}

function resolve_concurrency(value: number | undefined, n_cases: number): number {
  if (value === undefined) return Math.max(1, n_cases)
  if (!Number.isFinite(value) || value <= 0) return Math.max(1, n_cases)
  return Math.max(1, Math.floor(value))
}

function describe_flow_name<I, O>(flow: Step<I, O>): string {
  const display = flow.config?.['display_name']
  if (typeof display === 'string' && display.length > 0) return display
  return flow.id ?? flow.kind ?? 'flow'
}

function random_suffix(): string {
  return Math.random().toString(36).slice(2, 8)
}
