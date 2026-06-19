import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BenchReport } from '../bench.js'
import {
  read_baseline,
  regression_compare,
  write_baseline,
} from '../regression.js'

function make_report(overrides: Partial<BenchReport>): BenchReport {
  return {
    flow_name: 'sample',
    run_id: 'r1',
    cases: [],
    summary: {
      pass_rate: 1,
      mean_scores: {},
      total_duration_ms: 0,
      total_cost_usd: 0,
      mean_cost_usd: 0,
    },
    ...overrides,
  }
}

const BASE_SUMMARY = make_report({}).summary
function summary(overrides: Partial<BenchReport['summary']>): BenchReport['summary'] {
  return { ...BASE_SUMMARY, ...overrides }
}
function case_of(
  case_id: string,
  fields: { ok?: boolean; scores?: Record<string, unknown>; cost_usd?: number },
): BenchReport['cases'][number] {
  return {
    case_id,
    ok: fields.ok ?? true,
    scores: (fields.scores ?? {}) as Record<string, { score: number }>,
    duration_ms: 0,
    cost_usd: fields.cost_usd ?? 0,
  }
}
const cost_delta_metric = (out: ReturnType<typeof regression_compare>): boolean =>
  out.deltas.find((d) => d.metric === 'total_cost_usd')?.is_regression ?? false

describe('regression_compare', () => {
  it('reports ok=true when current matches baseline', () => {
    const base = make_report({})
    const cur = make_report({})
    const out = regression_compare(cur, base)
    expect(out.ok).toBe(true)
    expect(out.deltas.find((d) => d.metric === 'pass_rate')?.is_regression).toBe(false)
  })

  it('flags pass_rate regression when current drops', () => {
    const base = make_report({ summary: { ...make_report({}).summary, pass_rate: 1 } })
    const cur = make_report({ summary: { ...make_report({}).summary, pass_rate: 0.5 } })
    const out = regression_compare(cur, base)
    expect(out.ok).toBe(false)
    expect(out.deltas.find((d) => d.metric === 'pass_rate')?.is_regression).toBe(true)
  })

  it('flags judge mean drops as regressions', () => {
    const base = make_report({
      summary: { ...make_report({}).summary, mean_scores: { acc: 0.9 } },
    })
    const cur = make_report({
      summary: { ...make_report({}).summary, mean_scores: { acc: 0.85 } },
    })
    const out = regression_compare(cur, base)
    expect(out.ok).toBe(false)
    expect(out.deltas.find((d) => d.metric === 'mean_scores.acc')?.delta).toBeCloseTo(-0.05, 5)
  })

  it('treats cost increases above the threshold as regressions', () => {
    const base = make_report({
      summary: { ...make_report({}).summary, total_cost_usd: 1.0 },
    })
    const cur = make_report({
      summary: { ...make_report({}).summary, total_cost_usd: 1.2 },
    })
    const out = regression_compare(cur, base, { cost_threshold: 0.1 })
    const cost = out.deltas.find((d) => d.metric === 'total_cost_usd')
    expect(cost?.is_regression).toBe(true)
    expect(out.ok).toBe(false)
  })

  it('does not flag cost increases under the threshold', () => {
    const base = make_report({
      summary: { ...make_report({}).summary, total_cost_usd: 1.0 },
    })
    const cur = make_report({
      summary: { ...make_report({}).summary, total_cost_usd: 1.05 },
    })
    const out = regression_compare(cur, base, { cost_threshold: 0.1 })
    const cost = out.deltas.find((d) => d.metric === 'total_cost_usd')
    expect(cost?.is_regression).toBe(false)
  })

  it('produces per-case deltas with score and cost diffs', () => {
    const base = make_report({
      cases: [
        {
          case_id: 'a',
          ok: true,
          scores: { acc: { score: 0.9 } },
          duration_ms: 10,
          cost_usd: 0.10,
        },
      ],
    })
    const cur = make_report({
      cases: [
        {
          case_id: 'a',
          ok: false,
          scores: { acc: { score: 0.5 } },
          duration_ms: 11,
          cost_usd: 0.20,
        },
      ],
    })
    const out = regression_compare(cur, base)
    expect(out.per_case).toHaveLength(1)
    const a = out.per_case[0]
    expect(a?.case_id).toBe('a')
    expect(a?.score_deltas['acc']).toBeCloseTo(-0.4, 5)
    expect(a?.cost_delta).toBeCloseTo(0.1, 5)
    expect(a?.is_regression).toBe(true)
  })

  it('uses a 0.1 cost threshold by default', () => {
    const base = make_report({ summary: summary({ total_cost_usd: 1.0 }) })
    expect(
      cost_delta_metric(regression_compare(make_report({ summary: summary({ total_cost_usd: 1.2 }) }), base)),
    ).toBe(true) // +20% > default 10%
    expect(
      cost_delta_metric(regression_compare(make_report({ summary: summary({ total_cost_usd: 1.05 }) }), base)),
    ).toBe(false) // +5% < default 10%
  })

  it('honors a positive score_threshold for pass_rate and judge means', () => {
    const base = make_report({ summary: summary({ pass_rate: 1, mean_scores: { acc: 0.9 } }) })
    const cur = make_report({ summary: summary({ pass_rate: 0.95, mean_scores: { acc: 0.85 } }) })
    const lenient = regression_compare(cur, base, { score_threshold: 0.1 }) // drops of 0.05 < 0.1
    expect(lenient.deltas.find((d) => d.metric === 'pass_rate')?.is_regression).toBe(false)
    expect(lenient.deltas.find((d) => d.metric === 'mean_scores.acc')?.is_regression).toBe(false)
    const strict = regression_compare(cur, base)
    expect(strict.deltas.find((d) => d.metric === 'pass_rate')?.is_regression).toBe(true)
  })

  it('computes the cost ratio relative to the baseline cost', () => {
    const base = make_report({ summary: summary({ total_cost_usd: 2.0 }) })
    const cur = make_report({ summary: summary({ total_cost_usd: 2.1 }) }) // +0.1 absolute = 5% of 2.0
    expect(cost_delta_metric(regression_compare(cur, base, { cost_threshold: 0.1 }))).toBe(false)
  })

  it('requires the cost ratio to strictly exceed the threshold', () => {
    const base = make_report({ summary: summary({ total_cost_usd: 10 }) })
    const cur = make_report({ summary: summary({ total_cost_usd: 11 }) }) // exactly +10% (1/10 is exact here)
    expect(cost_delta_metric(regression_compare(cur, base, { cost_threshold: 0.1 }))).toBe(false)
  })

  it('treats any cost increase from a zero baseline as a regression', () => {
    const base = make_report({ summary: summary({ total_cost_usd: 0 }) })
    expect(
      cost_delta_metric(regression_compare(make_report({ summary: summary({ total_cost_usd: 0.5 }) }), base)),
    ).toBe(true)
    expect(
      cost_delta_metric(regression_compare(make_report({ summary: summary({ total_cost_usd: 0 }) }), base)),
    ).toBe(false)
  })

  it('flags a per-case cost regression against a positive baseline cost', () => {
    const base = make_report({ cases: [case_of('a', { cost_usd: 1.0 })] })
    const cur = make_report({ cases: [case_of('a', { cost_usd: 1.5 })] }) // +50%
    expect(regression_compare(cur, base, { cost_threshold: 0.1 }).per_case[0]?.is_regression).toBe(true)
  })

  it('flags a per-case cost regression when the baseline cost was zero', () => {
    const base = make_report({ cases: [case_of('a', { cost_usd: 0 })] })
    const cur = make_report({ cases: [case_of('a', { cost_usd: 0.5 })] })
    expect(regression_compare(cur, base).per_case[0]?.is_regression).toBe(true)
  })

  it('flags an ok -> not-ok per-case regression with no score or cost change', () => {
    const base = make_report({ cases: [case_of('a', { ok: true, scores: { acc: { score: 1 } }, cost_usd: 0 })] })
    const cur = make_report({ cases: [case_of('a', { ok: false, scores: { acc: { score: 1 } }, cost_usd: 0 })] })
    expect(regression_compare(cur, base).per_case[0]?.is_regression).toBe(true)
  })

  it('does not flag a per-case when score rises and cost holds', () => {
    const base = make_report({ cases: [case_of('a', { scores: { acc: { score: 0.8 } }, cost_usd: 0.1 })] })
    const cur = make_report({ cases: [case_of('a', { scores: { acc: { score: 0.9 } }, cost_usd: 0.1 })] })
    expect(regression_compare(cur, base).per_case[0]?.is_regression).toBe(false)
  })

  it('includes baseline/current only on the side a case exists', () => {
    const base = make_report({ cases: [case_of('only_base', {})] })
    const cur = make_report({ cases: [case_of('only_cur', {})] })
    const out = regression_compare(cur, base)
    const ob = out.per_case.find((c) => c.case_id === 'only_base') ?? {}
    const oc = out.per_case.find((c) => c.case_id === 'only_cur') ?? {}
    expect('baseline' in ob).toBe(true)
    expect('current' in ob).toBe(false)
    expect('current' in oc).toBe(true)
    expect('baseline' in oc).toBe(false)
  })

  it('reads numeric, object, missing, and non-finite per-case scores', () => {
    const base = make_report({
      cases: [case_of('a', { scores: { num: 0.5, obj: { score: 0.5 }, bad: { score: Number.NaN } } })],
    })
    const cur = make_report({
      cases: [case_of('a', { scores: { num: 0.8, obj: { score: 0.9 }, bad: { score: 0.7 }, missing_in_base: { score: 0.3 } } })],
    })
    const deltas = regression_compare(cur, base).per_case[0]?.score_deltas ?? {}
    expect(deltas['num']).toBeCloseTo(0.3, 5) // raw number score
    expect(deltas['obj']).toBeCloseTo(0.4, 5) // object score
    expect(deltas['bad']).toBeCloseTo(0.7, 5) // NaN baseline -> 0
    expect(deltas['missing_in_base']).toBeCloseTo(0.3, 5) // absent baseline -> 0
  })

  it('marks the report not ok when only a per-case regresses', () => {
    const base = make_report({ cases: [case_of('a', { ok: true })] })
    const cur = make_report({ cases: [case_of('a', { ok: false })] })
    const out = regression_compare(cur, base)
    expect(out.deltas.some((d) => d.is_regression)).toBe(false) // summary unchanged
    expect(out.ok).toBe(false) // ...but the per-case ok flip makes it not ok
  })

  it('scores one-sided cases against zero on the missing side', () => {
    const base = make_report({ cases: [case_of('a', { scores: { acc: { score: 0.8 } } })] })
    const cur = make_report({ cases: [case_of('b', { scores: { acc: { score: 0.9 } } })] })
    const out = regression_compare(cur, base)
    expect(out.per_case.find((c) => c.case_id === 'a')?.score_deltas['acc']).toBeCloseTo(-0.8, 5)
    expect(out.per_case.find((c) => c.case_id === 'b')?.score_deltas['acc']).toBeCloseTo(0.9, 5)
  })

  it('flags a per-case regression from a score drop alone', () => {
    const base = make_report({ cases: [case_of('a', { scores: { acc: { score: 0.9 } }, cost_usd: 0.1 })] })
    const cur = make_report({ cases: [case_of('a', { scores: { acc: { score: 0.5 } }, cost_usd: 0.1 })] })
    expect(regression_compare(cur, base).per_case[0]?.is_regression).toBe(true)
  })

  it('respects a positive score_threshold per case', () => {
    const base = make_report({ cases: [case_of('a', { scores: { acc: { score: 0.9 } } })] })
    const cur = make_report({ cases: [case_of('a', { scores: { acc: { score: 0.85 } } })] }) // drop 0.05
    expect(regression_compare(cur, base, { score_threshold: 0.1 }).per_case[0]?.is_regression).toBe(false)
  })

  it('computes the per-case cost ratio relative to the baseline cost', () => {
    const base = make_report({ cases: [case_of('a', { cost_usd: 2.0 })] })
    const cur = make_report({ cases: [case_of('a', { cost_usd: 2.1 })] }) // +5% of 2.0
    expect(regression_compare(cur, base, { cost_threshold: 0.1 }).per_case[0]?.is_regression).toBe(false)
  })

  it('does not flag a per-case cost regression when both costs are zero', () => {
    const base = make_report({ cases: [case_of('a', { cost_usd: 0 })] })
    const cur = make_report({ cases: [case_of('a', { cost_usd: 0 })] })
    expect(regression_compare(cur, base).per_case[0]?.is_regression).toBe(false)
  })

  it('reads null, non-number, and score-less per-case scores as zero', () => {
    const base = make_report({
      cases: [case_of('a', { scores: { nul: null, str: { score: 'high' }, noscore: { reason: 'x' } } })],
    })
    const cur = make_report({
      cases: [case_of('a', { scores: { nul: { score: 0.5 }, str: { score: 0.5 }, noscore: { score: 0.5 } } })],
    })
    const d = regression_compare(cur, base).per_case[0]?.score_deltas ?? {}
    expect(d['nul']).toBeCloseTo(0.5, 5) // baseline null -> 0
    expect(d['str']).toBeCloseTo(0.5, 5) // baseline non-number score -> 0
    expect(d['noscore']).toBeCloseTo(0.5, 5) // baseline object without `score` -> 0
  })

  it('does not flag an unchanged judge mean or pass_rate (strict-less-than boundary)', () => {
    const base = make_report({ summary: summary({ pass_rate: 1, mean_scores: { acc: 0.9 } }) })
    const cur = make_report({ summary: summary({ pass_rate: 1, mean_scores: { acc: 0.9 } }) })
    const out = regression_compare(cur, base)
    expect(out.deltas.find((d) => d.metric === 'mean_scores.acc')?.is_regression).toBe(false)
    expect(out.deltas.find((d) => d.metric === 'pass_rate')?.is_regression).toBe(false)
    expect(out.ok).toBe(true)
  })

  it('does not flag an unchanged per-case score (strict-less-than boundary)', () => {
    const base = make_report({ cases: [case_of('a', { scores: { acc: { score: 0.9 } }, cost_usd: 0.1 })] })
    const cur = make_report({ cases: [case_of('a', { scores: { acc: { score: 0.9 } }, cost_usd: 0.1 })] })
    expect(regression_compare(cur, base).per_case[0]?.is_regression).toBe(false)
  })

  it('requires the per-case cost ratio to strictly exceed the threshold', () => {
    const base = make_report({ cases: [case_of('a', { cost_usd: 10 })] })
    const cur = make_report({ cases: [case_of('a', { cost_usd: 11 })] }) // exactly +10%
    expect(regression_compare(cur, base, { cost_threshold: 0.1 }).per_case[0]?.is_regression).toBe(false)
  })

  it('flags a current-only case whose cost rose from an absent baseline', () => {
    const base = make_report({ cases: [] })
    const cur = make_report({ cases: [case_of('newcase', { cost_usd: 0.5 })] })
    expect(regression_compare(cur, base).per_case.find((c) => c.case_id === 'newcase')?.is_regression).toBe(true)
  })

  it('sorts judge metric names deterministically', () => {
    const base = make_report({ summary: summary({ mean_scores: { zeta: 0.9, alpha: 0.9 } }) })
    const cur = make_report({ summary: summary({ mean_scores: { zeta: 0.9, alpha: 0.9 } }) })
    const names = regression_compare(cur, base)
      .deltas.filter((d) => d.metric.startsWith('mean_scores.'))
      .map((d) => d.metric)
    expect(names).toEqual(['mean_scores.alpha', 'mean_scores.zeta'])
  })

  it('does not short-circuit on first failure', () => {
    const base = make_report({
      summary: {
        ...make_report({}).summary,
        pass_rate: 1,
        mean_scores: { a: 0.9, b: 0.8 },
      },
    })
    const cur = make_report({
      summary: {
        ...make_report({}).summary,
        pass_rate: 0.5,
        mean_scores: { a: 0.4, b: 0.3 },
      },
    })
    const out = regression_compare(cur, base)
    const regressions = out.deltas.filter((d) => d.is_regression).map((d) => d.metric)
    expect(regressions).toContain('pass_rate')
    expect(regressions).toContain('mean_scores.a')
    expect(regressions).toContain('mean_scores.b')
  })
})

describe('read/write_baseline', () => {
  it('round-trips a report through disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-baseline-'))
    try {
      const report = make_report({
        cases: [
          {
            case_id: 'x',
            ok: true,
            scores: { acc: { score: 1 } },
            duration_ms: 5,
            cost_usd: 0,
          },
        ],
        summary: {
          ...make_report({}).summary,
          mean_scores: { acc: 1 },
        },
      })
      const path = join(dir, 'sub', 'baseline.json')
      await write_baseline(path, report)
      const back = await read_baseline(path)
      expect(back.flow_name).toBe('sample')
      expect(back.cases).toHaveLength(1)
      expect(back.summary.mean_scores['acc']).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects malformed baseline files with branch-specific messages', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-baseline-bad-'))
    const { writeFile } = await import('node:fs/promises')
    let n = 0
    const reject_with = async (content: string, pattern: RegExp): Promise<void> => {
      n += 1
      const path = join(dir, `bad-${n}.json`)
      await writeFile(path, content, 'utf8')
      await expect(read_baseline(path)).rejects.toThrow(pattern)
    }
    try {
      await reject_with('"not an object"', /is not an object/)
      await reject_with('null', /is not an object/)
      await reject_with('{"cases":[],"summary":{}}', /missing flow_name\/run_id/)
      await reject_with('{"run_id":"r","cases":[],"summary":{}}', /missing flow_name\/run_id/) // flow_name only
      await reject_with('{"flow_name":"f","cases":[],"summary":{}}', /missing flow_name\/run_id/) // run_id only
      await reject_with('{"flow_name":"f","run_id":"r","summary":{}}', /missing cases\/summary/)
      await reject_with('{"flow_name":"f","run_id":"r","cases":[]}', /missing cases\/summary/)
      await reject_with('{"flow_name":"f","run_id":"r","cases":[],"summary":null}', /missing cases\/summary/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('accepts a well-formed baseline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-baseline-ok-'))
    try {
      const path = join(dir, 'ok.json')
      await write_baseline(path, make_report({}))
      await expect(read_baseline(path)).resolves.toMatchObject({ flow_name: 'sample', run_id: 'r1' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
