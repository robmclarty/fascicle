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

  it('rejects malformed baseline files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-baseline-bad-'))
    try {
      const path = join(dir, 'baseline.json')
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path, '"not an object"', 'utf8')
      await expect(read_baseline(path)).rejects.toThrow(/not an object/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
