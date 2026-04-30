import { describe, expect, it } from 'vitest'
import { run } from '../runner.js'
import { scope, stash, use } from '../scope.js'
import { step } from '../step.js'

describe('scope / stash / use', () => {
  it('reads two stashed values via a terminal use (criterion 16)', async () => {
    const flow = scope([
      stash('a', step('source_a', () => 1)),
      stash('b', step('source_b', () => 2)),
      use(['a', 'b'], (s) => (s.a as number) + (s.b as number)),
    ])
  
    const result = await run(flow, 'ignored', { install_signal_handlers: false })
    expect(result).toBe(3)
  })

  it('stash passes its source output through as its output', async () => {
    let seen_input: unknown = undefined
    const flow = scope([
      stash('a', step('source_a', () => 7)),
      step('after', (input: number) => {
        seen_input = input
        return input * 10
      }),
    ])
  
    const result = await run(flow, 'ignored', { install_signal_handlers: false })
    expect(seen_input).toBe(7)
    expect(result).toBe(70)
  })

  it('inner scope reads outer state; outer does not see inner state', async () => {
    const flow = scope([
      stash('outer_key', step('a', () => 'outer_value')),
      scope([
        stash('inner_key', step('b', () => 'inner_value')),
        use(['outer_key', 'inner_key'], (s) => ({
          outer: s.outer_key,
          inner: s.inner_key,
        })),
      ]),
      use(['outer_key', 'inner_key'], (s) => ({
        outer: s.outer_key,
        inner: s.inner_key,
      })),
    ])
  
    const result = await run(flow, 'ignored', { install_signal_handlers: false })
    expect(result).toEqual({ outer: 'outer_value', inner: undefined })
  })

  it('scope output equals the last child output', async () => {
    const flow = scope([
      stash('a', step('a', () => 1)),
      step('last', (_: number) => 'final' as const),
    ])
    const result = await run(flow, null, { install_signal_handlers: false })
    expect(result).toBe('final')
  })

  it('stash at top level throws the scope-marker error (F1)', async () => {
    const bare = stash('x', step('s', () => 1))
    await expect(run(bare, null, { install_signal_handlers: false })).rejects.toThrow(
      'stash() may only appear inside scope(); got: top-level',
    )
  })

  it('use at top level throws the scope-marker error (F1)', async () => {
    const bare = use(['x'], () => 'ok')
    await expect(run(bare, null, { install_signal_handlers: false })).rejects.toThrow(
      'use() may only appear inside scope(); got: top-level',
    )
  })

  it('inner scope stash does not overwrite outer state', async () => {
    const flow = scope([
      stash('key', step('outer_src', () => 'outer')),
      scope([
        stash('key', step('inner_src', () => 'inner')),
        use(['key'], (s) => s.key),
      ]),
      use(['key'], (s) => s.key),
    ])
    const result = await run(flow, null, { install_signal_handlers: false })
    expect(result).toBe('outer')
  })
})
