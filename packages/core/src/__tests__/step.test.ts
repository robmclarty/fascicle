import { describe, expect, it } from 'vitest';
import { run } from '../runner.js';
import { step } from '../step.js';

describe('step', () => {
  it('runs an atomic step via the runner', async () => {
    const s = step('inc', (x: number) => x + 1);
    await expect(run(s, 1)).resolves.toBe(2);
  });

  it('supports async step functions', async () => {
    const s = step('doubled', async (x: number) => x * 2);
    await expect(run(s, 5)).resolves.toBe(10);
  });

  it('assigns anon_<n> ids to anonymous steps', () => {
    const anon = step((x: number) => x);
    expect(anon.id).toMatch(/^anon_\d+$/);
    expect(anon.anonymous).toBe(true);
  });

  it('marks named steps as non-anonymous', () => {
    const named = step('n', (x: number) => x);
    expect(named.anonymous).toBeFalsy();
    expect(named.id).toBe('n');
  });

  it('assigns monotonically increasing ids for anonymous steps', () => {
    const a = step((x: number) => x);
    const b = step((x: number) => x);
    const a_n = Number.parseInt(a.id.slice('anon_'.length), 10);
    const b_n = Number.parseInt(b.id.slice('anon_'.length), 10);
    expect(b_n).toBeGreaterThan(a_n);
  });

  it('throws when a non-function is passed as the step fn', () => {
    expect(() => step('bad', undefined as unknown as (x: number) => number)).toThrow(TypeError);
  });

  it('attaches optional metadata when supplied as the third argument', () => {
    const labelled = step('inc', (x: number) => x + 1, {
      display_name: 'Increment',
      description: 'Adds one to its input',
      port_labels: { in: 'count', out: 'count + 1' },
    });
    expect(labelled.meta).toEqual({
      display_name: 'Increment',
      description: 'Adds one to its input',
      port_labels: { in: 'count', out: 'count + 1' },
    });
  });

  it('omits meta when not supplied', () => {
    const plain = step('p', (x: number) => x);
    expect(plain.meta).toBeUndefined();
  });
});
