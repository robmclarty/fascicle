import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sequence, step } from '@repo/core'
import type { TrajectoryEvent } from '@repo/core'
import { afterEach, describe, expect, it } from 'vitest'
import { bench, type CaseResult, type Score } from '../bench.js'
import { judge_equals, judge_with } from '../judges.js'

afterEach(() => {
  for (const l of process.listeners('SIGINT')) process.off('SIGINT', l)
  for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l)
})

const double = step('double', (n: number) => n * 2)

const emit_cost = (usd: number) =>
  step('emit_cost', (n: number, ctx) => {
    ctx.trajectory.record({ kind: 'cost', step_index: 0, total_usd: usd, source: 'engine_derived' })
    return n
  })

describe('bench', () => {
  it('runs each case, scores it, and reports pass_rate / mean_scores', async () => {
    const cases = [
      { id: 'a', input: 1, meta: { expected: 2 } },
      { id: 'b', input: 5, meta: { expected: 10 } },
      { id: 'c', input: 3, meta: { expected: 99 } },
    ]
    const report = await bench(double, cases, {
      doubled: judge_equals<number>(),
      odd: judge_with<number, number>(({ output }) => (output % 2 === 1 ? 1 : 0)),
    })

    expect(report.cases).toHaveLength(3)
    expect(report.summary.pass_rate).toBe(1)
    expect(report.cases[0]?.scores['doubled']).toEqual({ score: 1, reason: 'match' })
    expect(report.cases[2]?.scores['doubled']).toEqual({ score: 0, reason: 'mismatch' })
    expect(report.summary.mean_scores['doubled']).toBeCloseTo(2 / 3, 5)
    expect(report.summary.mean_scores['odd']).toBe(0)
  })

  it('captures errors per-case without aborting the whole bench', async () => {
    const flaky = step('flaky', (n: number) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    const report = await bench(flaky, [
      { id: 'ok', input: 1 },
      { id: 'fail', input: 2 },
      { id: 'ok2', input: 3 },
    ], {})
    expect(report.cases.map((c) => c.ok)).toEqual([true, false, true])
    expect(report.cases[1]?.error).toBe('boom')
    expect(report.summary.pass_rate).toBeCloseTo(2 / 3, 5)
  })

  it('omits judges that abstain (return undefined) from scores', async () => {
    const report = await bench(double, [{ id: 'x', input: 1 }], {
      always: judge_with<number, number>(() => 0.5),
      sometimes: judge_with<number, number>(() => undefined),
    })
    expect(report.cases[0]?.scores['always']).toEqual({ score: 0.5 })
    expect(report.cases[0]?.scores['sometimes']).toBeUndefined()
    expect(report.summary.mean_scores).toEqual({ always: 0.5 })
  })

  it('sums cost.total_usd events per case and overall', async () => {
    const flow = sequence([emit_cost(0.01), emit_cost(0.02)])
    const report = await bench(flow, [
      { id: 'a', input: 1 },
      { id: 'b', input: 2 },
    ], {})
    expect(report.cases[0]?.cost_usd).toBeCloseTo(0.03, 5)
    expect(report.cases[1]?.cost_usd).toBeCloseTo(0.03, 5)
    expect(report.summary.total_cost_usd).toBeCloseTo(0.06, 5)
    expect(report.summary.mean_cost_usd).toBeCloseTo(0.03, 5)
  })

  it('writes per-case JSONL when trajectory_dir is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-trajectory-'))
    try {
      const report = await bench(emit_cost(0.05), [{ id: 'case-1', input: 7 }], {}, {
        trajectory_dir: dir,
      })
      expect(report.cases[0]?.trajectory_path).toBe(join(dir, 'case-1.jsonl'))
      const text = await readFile(join(dir, 'case-1.jsonl'), 'utf8')
      const events: TrajectoryEvent[] = text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as TrajectoryEvent)
      const cost = events.find((e) => e.kind === 'cost') as { total_usd: number } | undefined
      expect(cost?.total_usd).toBe(0.05)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('streams CaseResult to on_case as cases finish', async () => {
    const seen: Array<{ id: string; ok: boolean }> = []
    await bench(double, [
      { id: 'a', input: 1 },
      { id: 'b', input: 2 },
    ], {}, {
      concurrency: 1,
      on_case: (r) => seen.push({ id: r.case_id, ok: r.ok }),
    })
    expect(seen).toEqual([
      { id: 'a', ok: true },
      { id: 'b', ok: true },
    ])
  })

  it('respects concurrency limit', async () => {
    let active = 0
    let max_active = 0
    const slow = step('slow', async (n: number) => {
      active += 1
      max_active = Math.max(max_active, active)
      await new Promise((r) => setTimeout(r, 5))
      active -= 1
      return n
    })
    const cases = Array.from({ length: 6 }, (_, i) => ({ id: `c${String(i)}`, input: i }))
    await bench(slow, cases, {}, { concurrency: 2 })
    expect(max_active).toBeLessThanOrEqual(2)
    expect(max_active).toBeGreaterThanOrEqual(1)
  })

  it('treats numeric judge returns as Score { score: n }', async () => {
    const report = await bench(double, [{ id: 'a', input: 1 }], {
      raw: judge_with<number, number>(() => 0.42),
    })
    expect(report.cases[0]?.scores['raw']).toEqual({ score: 0.42 })
  })

  it('records 0 pass_rate and empty mean_scores for empty cases array', async () => {
    const report = await bench(double, [], { e: judge_equals<number>() }, {})
    expect(report.cases).toHaveLength(0)
    expect(report.summary.pass_rate).toBe(0)
    expect(report.summary.mean_scores).toEqual({})
    expect(report.summary.total_cost_usd).toBe(0)
  })

  it('returns a stable shape with flow_name and run_id', async () => {
    const report = await bench(double, [{ id: 'a', input: 1 }], {}, { run_id: 'fixed' })
    expect(report.run_id).toBe('fixed')
    expect(report.flow_name).toBe('double')
    const cast: CaseResult = report.cases[0] as CaseResult
    expect(cast.case_id).toBe('a')
  })

  it('preserves the Score reason from object-shaped judge returns', async () => {
    const report = await bench(double, [{ id: 'a', input: 1 }], {
      reasoned: judge_with<number, number>(
        (): Score => ({ score: 0.7, reason: 'partial-credit' }),
      ),
    })
    expect(report.cases[0]?.scores['reasoned']).toEqual({ score: 0.7, reason: 'partial-credit' })
  })
})
