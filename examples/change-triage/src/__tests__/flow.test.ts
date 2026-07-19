/**
 * End-to-end flow tests through the real `run()` with a stub engine. Canned
 * responses are validated through the real assessment schema, so a schema
 * change breaks any test shipping stale fixture data.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { run } from 'fascicle'
import { describe, expect, it } from 'vitest'

import { make_stub_engine } from '../engine.js'
import { build_flow } from '../flow.js'

const FIXTURE = readFileSync(
  fileURLToPath(new URL('../../fixtures/risky.patch', import.meta.url)),
  'utf8',
)

const MODELS = { assessor: 'stub' }

function stub_with_score(score: number) {
  return make_stub_engine([
    {
      match_system_prefix: 'change-triage/assessor',
      content: {
        score,
        confidence: 'medium',
        summary: 'canned',
        factors: [{ id: 'model-only-factor', severity: 'low', detail: 'from the model' }],
      },
    },
  ])
}

describe('change-triage flow', () => {
  it('floors a lowball model score when hard signals are present', async () => {
    const report = await run(build_flow(stub_with_score(5), MODELS), {
      label: 'risky.patch',
      diff: FIXTURE,
    })
    // The fixture contains a migration and an auth change: floor is 50.
    expect(report.score).toBe(50)
    expect(report.band).toBe('high')
  })

  it('keeps a model score that already exceeds the floor', async () => {
    const report = await run(build_flow(stub_with_score(90), MODELS), {
      label: 'risky.patch',
      diff: FIXTURE,
    })
    expect(report.score).toBe(90)
    expect(report.band).toBe('critical')
  })

  it('merges detector and model factors, detectors first', async () => {
    const report = await run(build_flow(stub_with_score(5), MODELS), {
      label: 'risky.patch',
      diff: FIXTURE,
    })
    const ids = report.factors.map((f) => f.id)
    expect(ids).toContain('db-migration')
    expect(ids).toContain('auth-change')
    expect(ids).toContain('model-only-factor')
    expect(report.factors[0]?.source).toBe('detector')
  })

  it('discloses screened paths without sending their content to the model', async () => {
    const report = await run(build_flow(stub_with_score(5), MODELS), {
      label: 'risky.patch',
      diff: FIXTURE,
    })
    expect(report.screened_paths).toEqual(['seeds/accounts.seed.json'])
  })
})
