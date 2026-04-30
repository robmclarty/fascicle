import { is_step_kind, step, STEP_KINDS } from '@repo/core'
import { describe, expect, it } from 'vitest'
import { adversarial } from '../adversarial.js'
import { consensus } from '../consensus.js'
import { ensemble } from '../ensemble.js'
import { tournament } from '../tournament.js'

const COMPOSITE_KINDS = ['adversarial', 'ensemble', 'tournament', 'consensus'] as const

describe('composites STEP_KINDS coverage', () => {
  it('every composite kind is listed in STEP_KINDS', () => {
    for (const k of COMPOSITE_KINDS) {
      expect(STEP_KINDS).toContain(k)
      expect(is_step_kind(k)).toBe(true)
    }
  })

  it('every composite factory produces a step that wraps a compose() with the matching display_name', () => {
    const dummy = step('dummy', (n: number) => n)
    const builder = step('build', (i: { input: number }) => `c_${i.input}`)
    const critic = step('critique', (_c: string) => ({ notes: 'ok', verdict: 'pass' }))
  
    const built = [
      {
        kind: 'adversarial' as const,
        flow: adversarial({
          build: builder,
          critique: critic,
          accept: (r) => r['verdict'] === 'pass',
          max_rounds: 1,
        }),
      },
      {
        kind: 'ensemble' as const,
        flow: ensemble({ members: { a: dummy, b: dummy }, score: () => 1 }),
      },
      {
        kind: 'tournament' as const,
        flow: tournament({
          members: { a: dummy, b: dummy },
          compare: () => 'a' as const,
        }),
      },
      {
        kind: 'consensus' as const,
        flow: consensus({
          members: { a: dummy, b: dummy },
          agree: () => true,
          max_rounds: 1,
        }),
      },
    ]
  
    for (const entry of built) {
      expect(entry.flow.kind).toBe('compose')
      expect(entry.flow.config?.['display_name']).toBe(entry.kind)
    }
  })
})
