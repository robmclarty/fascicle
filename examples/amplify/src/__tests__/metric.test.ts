/**
 * The Metric protocol is the load-bearing abstraction: the harness never
 * inspects what a score means, so a malformed metric has to fail loudly at
 * load time rather than halfway through a run.
 */

import { describe, expect, it } from 'vitest'

import { load_metric, validate } from '../services/metric.js'

const VALID = {
  name: 'test',
  direction: 'minimize' as const,
  mutable_path: '/virtual/target.ts',
  gate: { command: ['true'], cwd: '/virtual' },
  score: () => 1,
}

describe('validate', () => {
  it('accepts a well-formed metric', () => {
    expect(validate(VALID, 'test').name).toBe('test')
  })

  it('rejects a non-object', () => {
    expect(() => validate('nope', 'test')).toThrow(/expected an object/)
  })

  it('names the first missing required field', () => {
    const { mutable_path: _unused, ...without_path } = VALID
    expect(() => validate(without_path, 'test')).toThrow(/missing required field "mutable_path"/)
  })

  it('rejects an unknown direction', () => {
    expect(() => validate({ ...VALID, direction: 'sideways' }, 'test')).toThrow(
      /direction must be "minimize" or "maximize"/,
    )
  })

  it('rejects a non-function score', () => {
    expect(() => validate({ ...VALID, score: 42 }, 'test')).toThrow(/"score" must be a function/)
  })

  it('names the source in the error', () => {
    expect(() => validate({}, 'builtin:speed')).toThrow(/metric from builtin:speed/)
  })
})

describe('load_metric', () => {
  it('loads each builtin from the package-root metrics directory', async () => {
    const metrics = await Promise.all(
      ['speed', 'golden', 'quality'].map((name) => load_metric(name, '/virtual')),
    )
    for (const metric of metrics) {
      expect(metric.name.length).toBeGreaterThan(0)
      expect(['minimize', 'maximize']).toContain(metric.direction)
    }
  })

  it('fails clearly when a custom path does not exist', async () => {
    await expect(load_metric('./no-such-metric.ts', '/virtual')).rejects.toThrow()
  })
})
