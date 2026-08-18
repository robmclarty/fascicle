import { describe, expect, it, vi } from 'vitest'
import { checkpoint } from '../checkpoint.js'
import { run } from '../runner.js'
import { step } from '../step.js'
import type { CheckpointStore } from '../types.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'

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

describe('checkpoint', () => {
  it('returns cached value on hit and does not invoke inner (spec §10 test 13)', async () => {
    const spy = vi.fn((x: number) => x + 1)
    const inner = step('add_one', spy)
    const flow = checkpoint(inner, { key: 'k1' })
    const store = memory_store()
    store.data.set('k1', 42)
  
    const result = await run(flow, 5, {
      checkpoint_store: store,
      install_signal_handlers: false,
    })
  
    expect(result).toBe(42)
    expect(spy).not.toHaveBeenCalled()
  })

  it('runs inner and persists result on miss (spec §10 test 14)', async () => {
    const inner = step('add_one', (x: number) => x + 1)
    const flow = checkpoint(inner, { key: 'k2' })
    const store = memory_store()
  
    const result = await run(flow, 5, {
      checkpoint_store: store,
      install_signal_handlers: false,
    })
  
    expect(result).toBe(6)
    expect(store.data.get('k2')).toBe(6)
  })

  it('treats a corrupted read as a miss', async () => {
    const inner = step('add_one', (x: number) => x + 1)
    const flow = checkpoint(inner, { key: 'k3' })
    const store: CheckpointStore = {
      async get() {
        throw new Error('corrupted')
      },
      async set() {
        // noop
      },
      async delete() {
        // noop
      },
    }
  
    const result = await run(flow, 5, {
      checkpoint_store: store,
      install_signal_handlers: false,
    })
    expect(result).toBe(6)
  })

  it('throws synchronously when wrapping an anonymous step (F6)', () => {
    const anon = step((x: number) => x + 1)
    expect(() => checkpoint(anon, { key: 'k' })).toThrow(
      'checkpoint requires a named step; got anonymous',
    )
  })

  it('invokes the key function with the input to derive the key', async () => {
    const inner = step('build', (i: { spec_hash: string }) => i.spec_hash)
    const flow = checkpoint(inner, { key: (i: { spec_hash: string }) => `build:${i.spec_hash}` })
    const store = memory_store()
  
    await run(flow, { spec_hash: 'abc' }, {
      checkpoint_store: store,
      install_signal_handlers: false,
    })
    expect(store.data.has('build:abc')).toBe(true)
  })

  it('wraps inner execution in a checkpoint span', async () => {
    const { logger, events } = recording_logger()
    const flow = checkpoint(step('add_one', (x: number) => x + 1), { key: 'k4' })

    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'checkpoint')
    expect(start).toBeDefined()
    const end = events.find((e) => e.kind === 'span_end' && e['span_id'] === start?.['span_id'])
    expect(end).toBeDefined()
    expect(end?.['error']).toBeUndefined()
  })

  it('records a checkpoint event with status hit on a cache hit', async () => {
    const { logger, events } = recording_logger()
    const flow = checkpoint(step('add_one', (x: number) => x + 1), { key: 'k_hit' })
    const store = memory_store()
    store.data.set('k_hit', 42)

    await run(flow, 5, {
      checkpoint_store: store,
      trajectory: logger,
      install_signal_handlers: false,
    })

    const lookups = events.filter((e) => e.kind === 'checkpoint')
    expect(lookups).toHaveLength(1)
    expect(lookups[0]?.['status']).toBe('hit')
    expect(lookups[0]?.['key']).toBe('k_hit')
    expect(lookups[0]?.['id']).toBe(flow.id)
    // Attributed to the checkpoint's own span so a viewer can nest it.
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'checkpoint')
    expect(lookups[0]?.['span_id']).toBe(start?.['span_id'])
  })

  it('records a checkpoint event with status miss when nothing is stored', async () => {
    const { logger, events } = recording_logger()
    const flow = checkpoint(step('add_one', (x: number) => x + 1), { key: 'k_miss' })
    const store = memory_store()

    const result = await run(flow, 5, {
      checkpoint_store: store,
      trajectory: logger,
      install_signal_handlers: false,
    })

    expect(result).toBe(6)
    const lookups = events.filter((e) => e.kind === 'checkpoint')
    expect(lookups).toHaveLength(1)
    expect(lookups[0]?.['status']).toBe('miss')
    expect(lookups[0]?.['key']).toBe('k_miss')
  })

  it('records a checkpoint event with status read_error when the store throws, and still runs inner', async () => {
    const { logger, events } = recording_logger()
    const flow = checkpoint(step('add_one', (x: number) => x + 1), { key: 'k_err' })
    const store: CheckpointStore = {
      async get() {
        throw new Error('corrupted')
      },
      async set() {
        // noop
      },
      async delete() {
        // noop
      },
    }

    const result = await run(flow, 5, {
      checkpoint_store: store,
      trajectory: logger,
      install_signal_handlers: false,
    })

    // The swallow-to-miss contract holds: a broken store never fails the run.
    expect(result).toBe(6)
    const lookups = events.filter((e) => e.kind === 'checkpoint')
    expect(lookups).toHaveLength(1)
    expect(lookups[0]?.['status']).toBe('read_error')
    expect(lookups[0]?.['key']).toBe('k_err')
    expect(lookups[0]?.['error']).toBe('corrupted')
  })

  it('records no checkpoint event when no store is configured', async () => {
    const { logger, events } = recording_logger()
    const flow = checkpoint(step('add_one', (x: number) => x + 1), { key: 'k_none' })

    await run(flow, 5, { trajectory: logger, install_signal_handlers: false })
    expect(events.filter((e) => e.kind === 'checkpoint')).toHaveLength(0)
  })
})
