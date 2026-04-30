import { adversarial, ensemble } from '@repo/composites'
import {
  checkpoint,
  describe as describe_tree,
  pipe,
  retry,
  run,
  scope,
  stash,
  step,
  use,
} from '@repo/core'
import type { CheckpointStore } from '@repo/core'
import { describe, expect, it, vi } from 'vitest'

function memory_store(): CheckpointStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get(key) {
      return data.has(key) ? data.get(key) : null
    },
    async set(key, value) {
      data.set(key, value)
    },
    async delete(key) {
      data.delete(key)
    },
  }
}

const judge_opus_fn = (): { verdict: string; confidence: number; notes: string } => ({
  verdict: 'pass',
  confidence: 0.9,
  notes: 'opus-notes',
})
const judge_sonnet_fn = (): { verdict: string; confidence: number; notes: string } => ({
  verdict: 'pass',
  confidence: 0.85,
  notes: 'sonnet-notes',
})
const deploy_fn = (input: { artifact: string }): string => `deployed:${input.artifact}`

describe('cross-composer substitutability', () => {
  it('retry wraps adversarial without either knowing about the other', async () => {
    let flaky_calls = 0
    const build = step(
      'build',
      (input: { input: string; prior?: string; critique?: string }) => {
        return `c_${input.input}`
      },
    )
    const critique = step('critique', () => {
      flaky_calls += 1
      if (flaky_calls === 1) throw new Error('flaky')
      return { notes: 'ok', verdict: 'pass' }
    })
  
    const adv = adversarial({
      build,
      critique,
      accept: (r) => r['verdict'] === 'pass',
      max_rounds: 2,
    })
  
    const flow = retry(adv, { max_attempts: 2, backoff_ms: 1 })
    const result = await run(flow, 'hello', { install_signal_handlers: false })
    expect(result.converged).toBe(true)
    expect(result.candidate).toBe('c_hello')
  })

  it('ensemble as critique inside adversarial (taste.md exemplar pattern)', async () => {
    const multi_judge = ensemble({
      members: {
        opus: step('judge_opus', () => ({ verdict: 'pass', confidence: 0.9, notes: 'opus' })),
        sonnet: step('judge_sonnet', () => ({
          verdict: 'pass',
          confidence: 0.7,
          notes: 'sonnet',
        })),
      },
      score: (r) => r.confidence,
    })
  
    const critique_step = pipe(multi_judge, (r) => r.winner)
  
    const adv = adversarial({
      build: step('build', (_: { input: string }) => 'candidate'),
      critique: critique_step,
      accept: (r) => r['verdict'] === 'pass',
      max_rounds: 2,
    })
  
    const result = await run(adv, 'input', { install_signal_handlers: false })
    expect(result.converged).toBe(true)
    expect(result.rounds).toBe(1)
  })

  it('constructs and runs the full taste.md exemplar', async () => {
    const plan_fn = vi.fn((i: { spec_hash: string; brief: string }) => ({
      spec_hash: i.spec_hash,
      plan: `plan-${i.brief}`,
    }))
    const build_fn = vi.fn(
      (
        input: {
          input: { spec_hash: string; plan: string }
          prior?: unknown
          critique?: string
        },
      ) => ({
        artifact: `build-${input.input.plan}`,
      }),
    )
    const multi_judge = ensemble({
      members: {
        opus: step('judge_opus', judge_opus_fn),
        sonnet: step('judge_sonnet', judge_sonnet_fn),
      },
      score: (r) => r.confidence,
    })
  
    const build_and_ship = scope([
      stash('plan', step('plan', plan_fn)),
      stash(
        'build',
        checkpoint(
          adversarial({
            build: step('build', build_fn),
            critique: pipe(multi_judge, (r) => r.winner),
            accept: (r) => r['verdict'] === 'pass',
            max_rounds: 3,
          }),
          { key: (i: { spec_hash: string; plan: string }) => `build:${i.spec_hash}` },
        ),
      ),
      use(['build'], (s) => {
        const b = s.build as { candidate: { artifact: string } }
        return deploy_fn(b.candidate)
      }),
    ])
  
    const store = memory_store()
    const result = await run(build_and_ship, { spec_hash: 'abc123', brief: 'hi' }, {
      install_signal_handlers: false,
      checkpoint_store: store,
    })
    expect(result).toBe('deployed:build-plan-hi')
    expect(plan_fn).toHaveBeenCalledTimes(1)
    expect(store.data.has('build:abc123')).toBe(true)
  })

  it('describe renders multi-line tree with nesting for every composer kind (criterion 19)', () => {
    const multi_judge = ensemble({
      members: {
        opus: step('judge_opus', () => ({ verdict: 'pass', confidence: 0.9, notes: 'x' })),
        sonnet: step('judge_sonnet', () => ({ verdict: 'pass', confidence: 0.8, notes: 'y' })),
      },
      score: (r) => r.confidence,
    })
  
    const sample_flow = scope([
      stash('plan', step('plan', () => ({ plan: 'p' }))),
      stash(
        'build',
        checkpoint(
          adversarial({
            build: step('build', (_: unknown) => ({ art: 'x' })),
            critique: pipe(multi_judge, (r) => r.winner),
            accept: (r) => r['verdict'] === 'pass',
            max_rounds: 3,
          }),
          { key: 'build' },
        ),
      ),
      use(['build'], (s) => s.build),
    ])
  
    const tree = describe_tree(sample_flow)
    const lines = tree.split('\n')
    expect(lines.length).toBeGreaterThan(5)
    expect(tree).toContain('scope(')
    expect(tree).toContain('stash(')
    expect(tree).toContain('use(')
    expect(tree).toContain('checkpoint(')
    expect(tree).toContain('adversarial(')
    expect(tree).toContain('ensemble(')
    expect(tree).toContain('pipe(')
    expect(tree).toContain('step(')
  })
})
