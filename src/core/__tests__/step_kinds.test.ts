import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { branch } from '../branch.js'
import { chain } from '../chain.js'
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

describe('STEP_KINDS registry', () => {
  it('STEP_KINDS contains exactly the documented set', () => {
    expect([...STEP_KINDS].toSorted()).toEqual(
      [
        'branch',
        'chain',
        'checkpoint',
        'compose',
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
        'use',
      ].toSorted(),
    )
  })

  it('lists exactly the kinds that the core constructors produce', () => {
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
      compose(dummy, { name: 'named' }),
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
      chain<number>()
        .step('n', ({ input }) => input)
        .output(({ n }) => n),
    ]
  
    for (const built of constructed) {
      expect(is_step_kind(built.kind)).toBe(true)
    }
  
    const constructed_kinds = new Set(constructed.map((s) => s.kind))
    for (const kind of STEP_KINDS) {
      expect(constructed_kinds).toContain(kind)
    }
  })

  it('is_step_kind rejects unknown strings and non-strings', () => {
    expect(is_step_kind('nonsense')).toBe(false)
    expect(is_step_kind(42)).toBe(false)
    expect(is_step_kind(null)).toBe(false)
  })
})
