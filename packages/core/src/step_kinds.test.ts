import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { adversarial } from './adversarial.js';
import { branch } from './branch.js';
import { checkpoint } from './checkpoint.js';
import { consensus } from './consensus.js';
import { ensemble } from './ensemble.js';
import { fallback } from './fallback.js';
import { map } from './map.js';
import { parallel } from './parallel.js';
import { pipe } from './pipe.js';
import { retry } from './retry.js';
import { scope, stash, use } from './scope.js';
import { sequence } from './sequence.js';
import { step } from './step.js';
import { is_step_kind, STEP_KINDS } from './step_kinds.js';
import { suspend } from './suspend.js';
import { timeout } from './timeout.js';
import { tournament } from './tournament.js';

const dummy = step('dummy', (n: number) => n);
const critic = step('critic', () => ({ notes: '' }));

describe('STEP_KINDS registry', () => {
  it('STEP_KINDS contains exactly the documented set', () => {
    expect([...STEP_KINDS].toSorted()).toEqual(
      [
        'adversarial',
        'branch',
        'checkpoint',
        'consensus',
        'ensemble',
        'fallback',
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
    );
  });

  it('every constructed primitive has a kind that STEP_KINDS recognizes', () => {
    const builder = step('builder', (i: { input: number }) => i.input);
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
      adversarial({
        build: builder,
        critique: critic,
        accept: () => true,
        max_rounds: 1,
      }),
      ensemble({ members: { a: dummy, b: dummy }, score: () => 1 }),
      tournament({ members: { a: dummy, b: dummy }, compare: () => 'a' as const }),
      consensus({ members: { a: dummy, b: dummy }, agree: () => true, max_rounds: 1 }),
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
    ];

    for (const built of constructed) {
      expect(is_step_kind(built.kind)).toBe(true);
    }

    const constructed_kinds = new Set(constructed.map((s) => s.kind));
    for (const kind of STEP_KINDS) {
      expect(constructed_kinds).toContain(kind);
    }
  });

  it('is_step_kind rejects unknown strings and non-strings', () => {
    expect(is_step_kind('nonsense')).toBe(false);
    expect(is_step_kind(42)).toBe(false);
    expect(is_step_kind(null)).toBe(false);
  });
});
