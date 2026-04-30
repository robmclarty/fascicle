import { describe, expect, it } from 'vitest'
import { branch } from '../branch.js'
import { run } from '../runner.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'

describe('error path propagation (spec §10 test 20)', () => {
  it('annotates errors with a root-to-leaf path array', async () => {
    const failing = step('fail_leaf', (_: number): number => {
      throw new Error('nope')
    })
    const flow = sequence([
      step('pre', (x: number) => x + 1),
      branch({
        when: (x: number) => x > 0,
        then: failing,
        otherwise: step('skipped', (x: number) => x),
      }),
    ])
  
    try {
      await run(flow, 1, { install_signal_handlers: false })
      throw new Error('expected run to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      const path = (err as { path?: unknown }).path
      expect(Array.isArray(path)).toBe(true)
      const path_arr = path as string[]
      expect(path_arr).toContain('fail_leaf')
      expect(path_arr.indexOf('fail_leaf')).toBeGreaterThan(0)
      const branch_idx = path_arr.findIndex((p) => p.startsWith('branch_'))
      const sequence_idx = path_arr.findIndex((p) => p.startsWith('sequence_'))
      expect(sequence_idx).toBeGreaterThanOrEqual(0)
      expect(branch_idx).toBeGreaterThan(sequence_idx)
      expect(path_arr[path_arr.length - 1]).toBe('fail_leaf')
    }
  })
})
