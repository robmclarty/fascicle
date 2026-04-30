import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { branch } from '../branch.js'
import { checkpoint } from '../checkpoint.js'
import { compose } from '../compose.js'
import { fallback } from '../fallback.js'
import { loop } from '../loop.js'
import { map } from '../map.js'
import { parallel } from '../parallel.js'
import { pipe } from '../pipe.js'
import { retry } from '../retry.js'
import { scope, stash, use } from '../scope.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'
import { is_step_kind, STEP_KINDS } from '../step_kinds.js'
import { suspend } from '../suspend.js'
import { timeout } from '../timeout.js'

const dummy = step('dummy', (n: number) => n)

// Kinds whose factories live outside @repo/core (in @repo/composites).
// Their constructor coverage is asserted in packages/composites/src/coverage.test.ts;
// here we only verify they are still listed in STEP_KINDS.
const COMPOSITE_KINDS = new Set<string>(['adversarial', 'ensemble', 'tournament', 'consensus'])

describe('STEP_KINDS registry', () => {
  it('STEP_KINDS contains exactly the documented set', () => {
    expect([...STEP_KINDS].toSorted()).toEqual(
      [
        'adversarial',
        'branch',
        'checkpoint',
        'compose',
        'consensus',
        'ensemble',
        'fallback',
        'loop',
        'map',
        'parallel',
        'pipe',
        'retry',
        'scope',
        'sequence',
        'stash',
        'step',
        'suspend',
        'timeout',
        'tournament',
        'use',
      ].toSorted(),
    )
  })

  it('every constructed core primitive has a kind that STEP_KINDS recognizes', () => {
    const constructed = [
      dummy,
      sequence([dummy]),
      parallel({ a: dummy }),
      branch({ when: () => true, then: dummy, otherwise: dummy }),
      map({ items: (n: number) => [n], do: dummy }),
      pipe(dummy, (n: number) => n),
      retry(dummy, { max_attempts: 1 }),
      fallback(dummy, dummy),
      timeout(dummy, 100),
      loop({
        init: (n: number) => n,
        body: step('inc', (n: number) => n + 1),
        finish: (n) => n,
        max_rounds: 1,
      }),
      compose('named', dummy),
      checkpoint(dummy, { key: () => 'k' }),
      suspend({
        id: 'pause',
        on: () => undefined,
        resume_schema: z.object({ ok: z.boolean() }),
        combine: (input: number) => input,
      }),
      scope([dummy]),
      stash('k', dummy),
      use(['k'], () => undefined),
    ]
  
    for (const built of constructed) {
      expect(is_step_kind(built.kind)).toBe(true)
    }
  
    // Every kind in STEP_KINDS that's NOT a composite must be constructable from core.
    // Composite kinds are covered by packages/composites/src/coverage.test.ts.
    const constructed_kinds = new Set(constructed.map((s) => s.kind))
    for (const kind of STEP_KINDS) {
      if (COMPOSITE_KINDS.has(kind)) continue
      expect(constructed_kinds).toContain(kind)
    }
  })

  it('is_step_kind rejects unknown strings and non-strings', () => {
    expect(is_step_kind('nonsense')).toBe(false)
    expect(is_step_kind(42)).toBe(false)
    expect(is_step_kind(null)).toBe(false)
  })
})
