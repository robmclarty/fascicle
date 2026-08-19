/**
 * bench: run a flow against a fixture set, score each result, return a report.
 *
 * Online counterpart to `learn`: where `learn` reflects on past trajectories
 * after the fact, `bench` runs the flow live against fresh cases and judges
 * each output.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { aborted_error, resolve_display_name, run, suspended_error } from '#core'
import type { Step, TrajectoryEvent, TrajectoryLogger } from '#core'
import { filesystem_logger, http_logger, tee_logger } from '#adapters'
import { bench_suspend_error } from './errors.js'

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
  readonly abort?: AbortSignal
}

/**
 * Runs `flow` against every case, judges each output, and produces a
 * `BenchReport` you can compare against a committed baseline via
 * `regression_compare`.
 *
 * Each case becomes one `run(flow, case.input, ...)`. Per-case observability:
 *   - `trajectory_dir` writes `${dir}/${case.id}.jsonl` via `filesystem_logger`
 *   - `live_url` POSTs each event via `http_logger` to a viewer's /api/ingest
 *   - both can be combined; bench tees them with an internal cost tracker
 *
 * Cost is tracked per-case in-process by intercepting `kind: 'cost'` events
 * on the trajectory pipeline, so the cost number matches what would be on
 * disk even when no `trajectory_dir` is set.
 *
 * Judges run as Steps after each case, with the same trajectory logger so
 * judge spans land in the case's trajectory file (or push). A judge that
 * throws or returns undefined abstains: the entry is omitted from
 * `case.scores` and the case does not contribute to that judge's mean.
 *
 * Control-flow signals are not case failures and never reach a `CaseResult`.
 * `abort` forwards to every per-case `run` and is re-checked before each case
 * is claimed, so cancelling rejects the whole bench rather than returning a
 * report that silently covers fewer cases than it was given. A
 * `suspended_error` from an approval gate rejects with `bench_suspend_error`:
 * `bench` has no resume path, so a suspend is a usage error, not a zero score.
 */
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
  const run_options = options.abort === undefined ? {} : { abort: options.abort }

  throw_if_aborted(options.abort)

  if (options.trajectory_dir !== undefined) {
    await mkdir(options.trajectory_dir, { recursive: true })
  }

  const judge_entries = Object.entries(judges)

  const run_one = async (bc: BenchCase<I>): Promise<CaseResult<I, O, S>> => {
    const { trajectory_path, case_logger, cost_tracker } = build_case_logging(options, bc.id)
    const ctx: CaseRunContext = { case_logger, install_signal_handlers, run_options }

    const start = Date.now()
    let output: O | undefined
    let error: string | undefined
    let ok = false
    try {
      output = await run(flow, bc.input, {
        trajectory: case_logger,
        install_signal_handlers,
        ...run_options,
      })
      ok = true
    } catch (err) {
      rethrow_control_flow(err, bc.id)
      error = err instanceof Error ? err.message : String(err)
      ok = false
    }

    const scores: Record<string, S> =
      ok && output !== undefined
        ? await run_judges(judge_entries, build_judge_input(bc, output), ctx, bc.id)
        : {}

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
      // The on_case callback receives the lossy-typed shape: bench's S is
      // generic but the callback hook is a single concrete signature.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      options.on_case(result as unknown as CaseResult)
    }
    return result
  }

  const cases_out = await run_with_concurrency(cases, concurrency, run_one, options.abort)

  // An abort that fires while every case is already in flight has no queue to
  // halt, and a flow that never checks `ctx.abort` finishes regardless. Both
  // would otherwise yield a full report for a cancelled run.
  throw_if_aborted(options.abort)

  const summary = summarize(cases_out, judge_entries.map(([n]) => n))

  return {
    flow_name,
    run_id,
    cases: cases_out,
    summary,
  }
}

/**
 * Per-case run context shared by the flow run and every judge run: the tee'd
 * trajectory logger, the signal-handler flag, and the optional abort forward.
 */
type CaseRunContext = {
  readonly case_logger: TrajectoryLogger
  readonly install_signal_handlers: boolean
  readonly run_options: { readonly abort?: AbortSignal }
}

/**
 * Builds the per-case trajectory pipeline: an optional filesystem sink when
 * `trajectory_dir` is set, an optional HTTP sink when `live_url` is set, and
 * always an in-process cost tracker, all tee'd together. Returns the resolved
 * trajectory path (undefined when no dir is set) alongside the logger and
 * tracker.
 */
function build_case_logging(
  options: BenchOptions,
  case_id: string,
): {
  readonly trajectory_path: string | undefined
  readonly case_logger: TrajectoryLogger
  readonly cost_tracker: ReturnType<typeof create_cost_tracker>
} {
  const trajectory_path =
    options.trajectory_dir === undefined
      ? undefined
      : join(options.trajectory_dir, `${case_id}.jsonl`)
  const sinks: TrajectoryLogger[] = []
  if (trajectory_path !== undefined) {
    sinks.push(filesystem_logger({ output_path: trajectory_path }))
  }
  if (options.live_url !== undefined) {
    sinks.push(http_logger({ url: options.live_url }))
  }
  const cost_tracker = create_cost_tracker()
  const case_logger: TrajectoryLogger =
    sinks.length === 0 ? cost_tracker.logger : tee_logger(...sinks, cost_tracker.logger)
  return { trajectory_path, case_logger, cost_tracker }
}

/**
 * Assembles the judge input triple, including `meta` only when the case
 * carries it so the optional field stays absent rather than `undefined`.
 */
function build_judge_input<I, O>(bc: BenchCase<I>, output: O): JudgeArgs<I, O> {
  return bc.meta === undefined
    ? { input: bc.input, output }
    : { input: bc.input, output, meta: bc.meta }
}

/**
 * Runs each judge as a Step over the case's input/output, collecting the
 * normalized scores. A judge that throws a control-flow signal rethrows via
 * `rethrow_control_flow`; any other throw, or an abstaining `undefined`,
 * omits that judge from the scores rather than failing the case.
 */
async function run_judges<I, O, S>(
  judge_entries: ReadonlyArray<readonly [string, Judge<I, O, S>]>,
  judge_input: JudgeArgs<I, O>,
  ctx: CaseRunContext,
  case_id: string,
): Promise<Record<string, S>> {
  const scores: Record<string, S> = {}
  for (const [name, judge] of judge_entries) {
    let raw: unknown
    try {
      // oxlint-disable-next-line no-await-in-loop
      raw = await run(judge, judge_input, {
        trajectory: ctx.case_logger,
        install_signal_handlers: ctx.install_signal_handlers,
        ...ctx.run_options,
      })
    } catch (err) {
      rethrow_control_flow(err, case_id)
      continue
    }
    const normalized = normalize_score(raw)
    if (normalized === undefined) continue
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    scores[name] = normalized as S
  }
  return scores
}

/**
 * Rethrows the control-flow signals that must never become a `CaseResult`.
 *
 * An `aborted_error` cancels the whole bench: a report claiming every
 * remaining case failed is worse than no report. A `suspended_error` becomes
 * `bench_suspend_error` naming the case, because `bench` cannot resume an
 * approval gate and scoring the paused case as a failure corrupts the
 * benchmark. Anything else returns, and the caller records it as a failure.
 */
function rethrow_control_flow(err: unknown, case_id: string): void {
  if (err instanceof aborted_error) throw err
  if (err instanceof suspended_error) throw new bench_suspend_error(case_id, err.suspend_id)
}

/**
 * Rejects once `signal` has fired, so an abort stops the bench claiming
 * further cases instead of running the queue to completion.
 *
 * Mirrors core's abort shape: an `Error` reason propagates verbatim, anything
 * else is wrapped, so a caller aborting with its own `aborted_error` sees that
 * instance rather than a copy.
 */
function throw_if_aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  const reason: unknown = signal.reason
  throw reason instanceof Error ? reason : new aborted_error('aborted', { reason })
}

/**
 * Aggregates per-case results into the report summary.
 *
 * A judge's mean only averages the cases where that judge produced a score;
 * abstained cases do not drag the mean down, and a judge that never scored
 * is omitted from `mean_scores` entirely.
 */
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

/**
 * Coerces a raw judge return value into a `Score`.
 *
 * Accepts a bare finite number or an object with a finite numeric `score`
 * and optional string `reason`. Anything else (including NaN/Infinity, or a
 * non-string `reason`, which is dropped) normalizes toward `undefined` or a
 * reason-less score; `undefined` means the judge abstained.
 */
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

/**
 * Extracts the numeric value from a score-shaped entry, tolerating both bare
 * numbers and `{ score }` objects since `S` is caller-defined.
 */
function score_value_of(s: unknown): number | undefined {
  if (s === undefined || s === null) return undefined
  if (typeof s === 'number') return Number.isFinite(s) ? s : undefined
  if (typeof s === 'object' && 'score' in s) {
    const raw = (s as Record<string, unknown>)['score']
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
  }
  return undefined
}

/**
 * Builds a minimal `TrajectoryLogger` that ignores everything except
 * `kind: 'cost'` events and accumulates their `total_usd` into a running
 * total, read back via `total()` after the case finishes.
 */
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

/**
 * Runs `fn` over `items` with at most `limit` calls in flight, preserving
 * input order in the results.
 *
 * Uses a shared-index worker pool: each of the `limit` workers claims the
 * next unclaimed index and writes its result into that slot, so completion
 * order never reorders the output.
 *
 * `abort` is re-checked before each claim, so a signal that fires mid-run
 * halts scheduling at the queue rather than only cancelling work already in
 * flight. The full fan-out path has no queue to halt: every item is already
 * running, so the caller re-checks the signal before reading the results.
 */
async function run_with_concurrency<t, r>(
  items: ReadonlyArray<t>,
  limit: number,
  fn: (item: t) => Promise<r>,
  abort?: AbortSignal,
): Promise<r[]> {
  if (items.length === 0) return []
  if (limit >= items.length) {
    return Promise.all(items.map((it) => fn(it)))
  }
  const results: r[] = Array.from({ length: items.length })
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      throw_if_aborted(abort)
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

/**
 * Clamps the requested concurrency to a positive integer, defaulting to full
 * fan-out (one worker per case) when unset or invalid.
 */
function resolve_concurrency(value: number | undefined, n_cases: number): number {
  if (value === undefined) return Math.max(1, n_cases)
  if (!Number.isFinite(value) || value <= 0) return Math.max(1, n_cases)
  return Math.max(1, Math.floor(value))
}

/**
 * Picks a human-readable name for the report, resolving the display channels
 * the same way spans and `describe` do, then falling back to identity.
 */
function describe_flow_name<I, O>(flow: Step<I, O>): string {
  return resolve_display_name(flow, flow.id ?? flow.kind ?? 'flow')
}

/**
 * Short random base36 suffix to keep default run ids unique across
 * same-millisecond starts.
 */
function random_suffix(): string {
  return Math.random().toString(36).slice(2, 8)
}
