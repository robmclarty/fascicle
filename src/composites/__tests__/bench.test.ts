import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sequence, step } from '#core'
import type { Step, TrajectoryEvent } from '#core'
import { afterEach, describe, expect, it } from 'vitest'
import { bench, type CaseResult, normalize_score, type Score } from '../bench.js'
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

  it('generates a bench-prefixed run_id when none is provided', async () => {
    const report = await bench(double, [{ id: 'a', input: 1 }], {})
    expect(report.run_id).toMatch(/^bench-\d+-[a-z0-9]+$/)
  })

  it('uses the flow display_name for flow_name when present', async () => {
    const flow = {
      id: 'inner_id',
      kind: 'step',
      run: (n: number) => n,
      config: { display_name: 'Pretty Flow' },
    }
    const report = await bench(flow as unknown as Step<number, number>, [{ id: 'a', input: 1 }], {})
    expect(report.flow_name).toBe('Pretty Flow')
  })

  it('falls back to flow.id when display_name is an empty string', async () => {
    const flow = {
      id: 'fallback_id',
      kind: 'step',
      run: (n: number) => n,
      config: { display_name: '' },
    }
    const report = await bench(flow as unknown as Step<number, number>, [{ id: 'a', input: 1 }], {})
    expect(report.flow_name).toBe('fallback_id')
  })

  it('does not run judges for a failed case', async () => {
    const flaky = step('flaky', (n: number) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    let judge_calls = 0
    const report = await bench(flaky, [
      { id: 'ok', input: 1 },
      { id: 'fail', input: 2 },
    ], {
      counter: judge_with<number, number>(() => {
        judge_calls += 1
        return 1
      }),
    })
    expect(report.cases[1]?.ok).toBe(false)
    expect(report.cases[1]?.scores).toEqual({})
    expect(judge_calls).toBe(1)
  })

  it('does not run judges when a successful flow returns undefined', async () => {
    const voidf = step('voidf', () => undefined as unknown as number)
    let judged = false
    const report = await bench(voidf, [{ id: 'a', input: 1 }], {
      j: judge_with<number, number>(() => {
        judged = true
        return 1
      }),
    })
    expect(report.cases[0]?.ok).toBe(true)
    expect(report.cases[0]?.scores).toEqual({})
    expect(judged).toBe(false)
  })

  it('treats a throwing judge as an abstention and omits it from scores', async () => {
    const report = await bench(double, [{ id: 'a', input: 1 }], {
      boom: judge_with<number, number>(() => {
        throw new Error('judge fail')
      }),
      fine: judge_with<number, number>(() => 1),
    })
    const scores = report.cases[0]?.scores ?? {}
    expect('boom' in scores).toBe(false)
    expect(scores['fine']).toEqual({ score: 1 })
  })

  it('ignores cost events whose total_usd is not a finite number', async () => {
    const bad_cost = step('bad_cost', (n: number, ctx) => {
      ctx.trajectory.record({ kind: 'cost', step_index: 0, total_usd: Number.NaN, source: 'engine_derived' })
      ctx.trajectory.record({
        kind: 'cost',
        step_index: 1,
        total_usd: 'lots' as unknown as number,
        source: 'engine_derived',
      })
      ctx.trajectory.record({ kind: 'cost', step_index: 2, total_usd: 0.05, source: 'engine_derived' })
      return n
    })
    const report = await bench(bad_cost, [{ id: 'a', input: 1 }], {})
    expect(report.cases[0]?.cost_usd).toBeCloseTo(0.05, 5)
  })

  it('creates a missing trajectory_dir, including nested paths', async () => {
    const base = await mkdtemp(join(tmpdir(), 'bench-nested-'))
    const dir = join(base, 'a', 'b', 'c')
    try {
      const report = await bench(emit_cost(0.01), [{ id: 'case-1', input: 1 }], {}, {
        trajectory_dir: dir,
      })
      expect(report.cases[0]?.trajectory_path).toBe(join(dir, 'case-1.jsonl'))
      const text = await readFile(join(dir, 'case-1.jsonl'), 'utf8')
      expect(text.length).toBeGreaterThan(0)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  it('POSTs trajectory events to live_url via http_logger', async () => {
    const received: string[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        received.push(body)
        res.writeHead(200)
        res.end('ok')
      })
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      await bench(emit_cost(0.02), [{ id: 'c1', input: 1 }], {}, {
        live_url: `http://127.0.0.1:${String(port)}/api/ingest`,
      })
      const deadline = Date.now() + 1000
      while (received.length === 0 && Date.now() < deadline) {
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      expect(received.length).toBeGreaterThan(0)
      expect(received.join('')).toContain('cost')
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
  })
})

describe('bench result shape and summary math', () => {
  it('reports total_duration_ms as the plausible sum of per-case durations', async () => {
    const report = await bench(double, [
      { id: 'a', input: 1 },
      { id: 'b', input: 2 },
    ], {})
    const sum = report.cases.reduce((acc, c) => acc + c.duration_ms, 0)
    expect(report.summary.total_duration_ms).toBe(sum)
    expect(report.summary.total_duration_ms).toBeGreaterThanOrEqual(0)
    for (const c of report.cases) {
      expect(c.duration_ms).toBeGreaterThanOrEqual(0)
      expect(c.duration_ms).toBeLessThan(60_000)
    }
  })

  it('includes output but omits error and trajectory_path for a clean success', async () => {
    const report = await bench(double, [{ id: 'a', input: 1 }], {})
    const c = report.cases[0] ?? ({} as CaseResult)
    expect('output' in c).toBe(true)
    expect('error' in c).toBe(false)
    expect('trajectory_path' in c).toBe(false)
  })

  it('omits the output key and includes error for a failed case', async () => {
    const flaky = step('flaky', (n: number) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    const report = await bench(flaky, [{ id: 'fail', input: 2 }], {})
    const c = report.cases[0] ?? ({} as CaseResult)
    expect('output' in c).toBe(false)
    expect('error' in c).toBe(true)
  })

  it('reports mean_cost_usd of 0 for an empty cases array', async () => {
    const report = await bench(double, [], {}, {})
    expect(report.summary.mean_cost_usd).toBe(0)
  })

  it('passes case meta to judges only when the case carries meta', async () => {
    let with_meta_seen: boolean | undefined
    let without_meta_seen: boolean | undefined
    await bench(double, [
      { id: 'm', input: 1, meta: { tag: 'x' } },
      { id: 'n', input: 2 },
    ], {
      probe: judge_with<number, number>((args) => {
        if (args.input === 1) with_meta_seen = 'meta' in args
        else without_meta_seen = 'meta' in args
        return 1
      }),
    }, { concurrency: 1 })
    expect(with_meta_seen).toBe(true)
    expect(without_meta_seen).toBe(false)
  })

  it('feeds the real flow output to judges for cases without meta', async () => {
    const report = await bench(double, [{ id: 'a', input: 4 }], {
      check: judge_with<number, number>(({ output }) => (output === 8 ? 1 : 0)),
    })
    expect(report.cases[0]?.scores['check']).toEqual({ score: 1 })
  })
})

describe('bench concurrency', () => {
  function tracking_slow(delay = 5): { flow: Step<number, number>; peak: () => number } {
    let active = 0
    let max_active = 0
    const flow = step('slow', async (n: number) => {
      active += 1
      max_active = Math.max(max_active, active)
      await new Promise((resolve) => setTimeout(resolve, delay))
      active -= 1
      return n
    })
    return { flow, peak: () => max_active }
  }

  it('runs all cases in parallel when concurrency is unset', async () => {
    const { flow, peak } = tracking_slow()
    const cases = Array.from({ length: 3 }, (_, i) => ({ id: `c${String(i)}`, input: i }))
    await bench(flow, cases, {})
    expect(peak()).toBe(3)
  })

  it('treats a concurrency of 0 as no limit', async () => {
    const { flow, peak } = tracking_slow()
    const cases = Array.from({ length: 3 }, (_, i) => ({ id: `c${String(i)}`, input: i }))
    await bench(flow, cases, {}, { concurrency: 0 })
    expect(peak()).toBe(3)
  })

  it('reaches but does not exceed an explicit concurrency limit', async () => {
    const { flow, peak } = tracking_slow()
    const cases = Array.from({ length: 6 }, (_, i) => ({ id: `c${String(i)}`, input: i }))
    await bench(flow, cases, {}, { concurrency: 3 })
    expect(peak()).toBe(3)
  })
})

describe('normalize_score', () => {
  it('returns undefined for null and undefined', () => {
    expect(normalize_score(undefined)).toBeUndefined()
    expect(normalize_score(null)).toBeUndefined()
  })

  it('wraps a finite number as { score }', () => {
    expect(normalize_score(0.5)).toEqual({ score: 0.5 })
    expect(normalize_score(0)).toEqual({ score: 0 })
  })

  it('rejects non-finite numbers', () => {
    expect(normalize_score(Number.NaN)).toBeUndefined()
    expect(normalize_score(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('accepts an object carrying a finite numeric score', () => {
    expect(normalize_score({ score: 0.7 })).toEqual({ score: 0.7 })
  })

  it('rejects an object whose score is non-numeric or non-finite', () => {
    expect(normalize_score({ score: 'x' })).toBeUndefined()
    expect(normalize_score({ score: Number.NaN })).toBeUndefined()
  })

  it('rejects values that are neither a number nor a scored object', () => {
    expect(normalize_score('hi')).toBeUndefined()
    expect(normalize_score(true)).toBeUndefined()
    expect(normalize_score({})).toBeUndefined()
  })

  it('keeps a string reason', () => {
    expect(normalize_score({ score: 1, reason: 'good' })).toEqual({ score: 1, reason: 'good' })
  })

  it('drops a non-string reason but keeps the score', () => {
    const r = normalize_score({ score: 1, reason: 123 })
    expect(r).toEqual({ score: 1 })
    expect('reason' in (r ?? {})).toBe(false)
  })

  it('omits the reason key entirely when no reason is present', () => {
    const r = normalize_score({ score: 2 })
    expect(r).toEqual({ score: 2 })
    expect('reason' in (r ?? {})).toBe(false)
  })
})
