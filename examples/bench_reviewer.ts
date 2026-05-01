/**
 * bench_reviewer: drives the bench primitive against the markdown-defined
 * `reviewer` agent.
 *
 * Cases come from bench/reviewer/cases.json so the example file stays
 * focused on the wiring. Judges check:
 *   - flagged_correctly: at least one finding's category matches
 *     meta.expects_category (skipped when null)
 *   - severity_match: the worst finding's severity matches
 *     meta.expects_severity (or no findings when expected is null)
 *
 * The engine is a stub returning canned, schema-conforming findings keyed by
 * case id. Swap `make_stub_engine` for `create_engine({...})` to drive the
 * same flow against a real provider.
 *
 * Run directly to record a baseline:
 *   WRITE_BASELINE=1 pnpm exec tsx examples/bench_reviewer.ts
 *
 * Subsequent runs compare against bench/reviewer/baseline.json and exit 1 on
 * regression.
 */

import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  reviewer,
  type ReviewFinding,
  type ReviewerInput,
  type ReviewerOutput,
} from '@repo/agents'
import {
  bench,
  judge_with,
  read_baseline,
  regression_compare,
  write_baseline,
  type Engine,
  type GenerateOptions,
  type GenerateResult,
} from '@repo/fascicle'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..')
const CASES_PATH = join(REPO_ROOT, 'bench', 'reviewer', 'cases.json')
const BASELINE_PATH = join(REPO_ROOT, 'bench', 'reviewer', 'baseline.json')

type Case = {
  readonly id: string
  readonly input: ReviewerInput
  readonly meta: {
    readonly expects_severity: ReviewFinding['severity'] | null
    readonly expects_category?: string
  }
}

const SEVERITY_RANK: Record<ReviewFinding['severity'], number> = {
  info: 0,
  minor: 1,
  major: 2,
  blocker: 3,
}

const CANNED_FINDINGS: Record<string, ReviewFinding[]> = {
  'sql-injection': [
    {
      severity: 'blocker',
      file: 'src/db.ts',
      line: 4,
      category: 'security',
      message: 'Concatenated user input into raw SQL: a classic injection vector.',
      suggestion: 'Use a parameterised query.',
    },
  ],
  'missing-test': [
    {
      severity: 'minor',
      category: 'tests',
      message: 'New refund() lacks any test coverage.',
    },
  ],
  'safe-rename': [],
}

const CANNED_SUMMARY: Record<string, string> = {
  'sql-injection': 'one blocker security issue.',
  'missing-test': 'add a test for refund().',
  'safe-rename': 'safe rename, no issues.',
}

function make_stub_engine(): Engine {
  return {
    generate: async <t = string>(opts: GenerateOptions<t>): Promise<GenerateResult<t>> => {
      const text = extract_prompt_text(opts)
      const id = pick_case_id(text)
      const findings = CANNED_FINDINGS[id] ?? []
      const summary = CANNED_SUMMARY[id] ?? 'no findings.'
      const reply: ReviewerOutput = { findings, summary }
      const parsed = opts.schema ? opts.schema.parse(reply) : reply
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: parsed as t,
        tool_calls: [],
        steps: [],
        usage: { input_tokens: 220, output_tokens: 95 },
        finish_reason: 'stop',
        model_resolved: { provider: 'stub', model_id: 'reviewer-canned' },
      }
    },
    register_alias: () => {},
    unregister_alias: () => {},
    resolve_alias: () => ({ provider: 'stub', model_id: 'reviewer-canned' }),
    list_aliases: () => ({}),
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    dispose: async () => {},
  }
}

function extract_prompt_text<t>(opts: GenerateOptions<t>): string {
  if (typeof opts.prompt === 'string') return opts.prompt
  if (Array.isArray(opts.prompt)) {
    const last = opts.prompt.at(-1)
    if (last !== undefined) {
      return typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
    }
  }
  return ''
}

function pick_case_id(prompt: string): string {
  if (prompt.includes('SELECT * FROM users')) return 'sql-injection'
  if (prompt.includes('refund')) return 'missing-test'
  if (prompt.includes('get_cwd') || prompt.includes('getCwd')) return 'safe-rename'
  return 'safe-rename'
}

function worst_severity(findings: ReadonlyArray<ReviewFinding>): ReviewFinding['severity'] | null {
  if (findings.length === 0) return null
  let worst: ReviewFinding['severity'] = findings[0]?.severity ?? 'info'
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity
  }
  return worst
}

function is_severity(value: unknown): value is ReviewFinding['severity'] {
  return value === 'info' || value === 'minor' || value === 'major' || value === 'blocker'
}

function is_record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

const REVIEW_FOCUS = new Set(['correctness', 'security', 'style', 'tests'])

function is_review_focus(v: unknown): v is 'correctness' | 'security' | 'style' | 'tests' {
  return typeof v === 'string' && REVIEW_FOCUS.has(v)
}

function coerce_reviewer_input(value: unknown): ReviewerInput {
  if (!is_record(value)) throw new Error('case input is not an object')
  const diff = value['diff']
  if (typeof diff !== 'string') throw new Error('case input missing diff')
  const focus = value['focus']
  if (Array.isArray(focus)) {
    return { diff, focus: focus.filter(is_review_focus) }
  }
  return { diff }
}

function coerce_case(raw: unknown): Case {
  if (!is_record(raw)) throw new Error('case entry is not an object')
  const id = raw['id']
  const meta_raw = raw['meta']
  if (typeof id !== 'string') throw new Error('case missing id')
  if (!is_record(meta_raw)) throw new Error('case missing meta')
  const expects_severity = meta_raw['expects_severity']
  const severity_field: ReviewFinding['severity'] | null =
    expects_severity === null ? null : (is_severity(expects_severity) ? expects_severity : null)
  const expects_category = meta_raw['expects_category']
  return {
    id,
    input: coerce_reviewer_input(raw['input']),
    meta: {
      expects_severity: severity_field,
      ...(typeof expects_category === 'string' ? { expects_category } : {}),
    },
  }
}

export async function run_bench_reviewer(): Promise<void> {
  const raw_cases: unknown = JSON.parse(await readFile(CASES_PATH, 'utf8'))
  if (!Array.isArray(raw_cases)) throw new Error('cases.json is not an array')
  const cases: Case[] = raw_cases.map(coerce_case)
  const engine = make_stub_engine()
  try {
    const reviewer_step = reviewer({ engine })

    const judges = {
      flagged_correctly: judge_with<ReviewerInput, ReviewerOutput>(({ output, meta }) => {
        const expected = meta?.['expects_category']
        if (typeof expected !== 'string') return undefined
        const hit = output.findings.some((f) => f.category === expected)
        return { score: hit ? 1 : 0, reason: hit ? `flagged ${expected}` : `missed ${expected}` }
      }),
      severity_match: judge_with<ReviewerInput, ReviewerOutput>(({ output, meta }) => {
        if (meta === undefined || !('expects_severity' in meta)) return undefined
        const raw = meta['expects_severity']
        const expected: ReviewFinding['severity'] | null = raw === null
          ? null
          : (is_severity(raw) ? raw : null)
        const got = worst_severity(output.findings)
        if (expected === null) {
          return { score: got === null ? 1 : 0, reason: got === null ? 'no findings' : `unexpected ${got}` }
        }
        return {
          score: got === expected ? 1 : 0,
          reason: got === expected ? `severity ${expected}` : `expected ${expected}, got ${got ?? 'none'}`,
        }
      }),
    }

    const report = await bench(reviewer_step, cases, judges)

    console.log('flow:           ', report.flow_name)
    console.log('cases:          ', report.cases.length)
    console.log('pass_rate:      ', report.summary.pass_rate.toFixed(3))
    console.log('mean scores:    ', report.summary.mean_scores)
    console.log('total cost:     ', `$${report.summary.total_cost_usd.toFixed(4)}`)
    console.log('total duration: ', `${String(report.summary.total_duration_ms)}ms`)

    if (process.env['WRITE_BASELINE'] === '1') {
      await write_baseline(BASELINE_PATH, report)
      console.log(`\nbaseline written to ${BASELINE_PATH}`)
      return
    }

    let baseline
    try {
      baseline = await read_baseline(BASELINE_PATH)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`could not read baseline at ${BASELINE_PATH}: ${message}`)
      console.error('re-run with WRITE_BASELINE=1 to record one.')
      process.exit(2)
    }
    const diff = regression_compare(report, baseline)
    if (!diff.ok) {
      console.error('\nregression detected:')
      for (const delta of diff.deltas.filter((entry) => entry.is_regression)) {
        console.error(`  - ${delta.metric}: ${delta.baseline.toFixed(4)} -> ${delta.current.toFixed(4)} (Δ ${delta.delta.toFixed(4)})`)
      }
      for (const case_diff of diff.per_case.filter((entry) => entry.is_regression)) {
        console.error(`  - case ${case_diff.case_id}: cost Δ ${case_diff.cost_delta.toFixed(4)}, scores ${JSON.stringify(case_diff.score_deltas)}`)
      }
      process.exit(1)
    }
    console.log('\nno regressions vs baseline.')
  } finally {
    await engine.dispose()
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_bench_reviewer().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
