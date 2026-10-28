import { describe, expect, it, vi } from 'vitest'
import { checkpoint } from '../checkpoint.js'
import { run } from '../runner.js'
import { step } from '../step.js'
import type { AnyStep, CheckpointStore, Step } from '../types.js'
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

// A store that misses every lookup and throws `thrown` on every write.
function failing_writes(thrown: unknown): CheckpointStore {
  return {
    async get() {
      return null
    },
    async set() {
      throw thrown
    },
    async delete() {
      // noop
    },
  }
}

describe('checkpoint', () => {
  it('returns cached value on hit and does not invoke inner', async () => {
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

  it('runs inner and persists result on miss', async () => {
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

  it('throws synchronously when wrapping an anonymous step', () => {
    const anon = step((x: number) => x + 1)
    expect(() => checkpoint(anon, { key: 'k' })).toThrow(
      "checkpoint requires a named step, got anonymous — give the inner step an id with step('id', fn)",
    )
  })

  it('numbers each checkpoint it builds and shows its key and label in its config', () => {
    const first = checkpoint(step('a', (n: number) => n), { key: 'k_a' })
    const second = checkpoint(step('b', (n: number) => n), { key: 'k_b', name: 'cache b' })
    expect(first.id).toMatch(/^checkpoint_\d+$/)
    expect(Number(second.id.slice('checkpoint_'.length))).toBe(Number(first.id.slice('checkpoint_'.length)) + 1)
    expect(first.config).toStrictEqual({ key: 'k_a' })
    expect(second.config).toStrictEqual({ key: 'k_b', display_name: 'cache b' })
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

  it.each([
    ['an Error', new Error('disk full'), 'disk full'],
    ['a bare value', 'quota exceeded', 'quota exceeded'],
  ])(
    'records write_error and returns the inner result when the store fails the write with %s',
    async (_, thrown, message) => {
      const { logger, events } = recording_logger()
      const flow = checkpoint(step('add_one', (x: number) => x + 1), { key: 'k_write' })

      const result = await run(flow, 5, {
        checkpoint_store: failing_writes(thrown),
        trajectory: logger,
        install_signal_handlers: false,
      })

      // The inner step already ran and was paid for, so a cache that can't
      // keep its result doesn't take the result away.
      expect(result).toBe(6)
      const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'checkpoint')
      const meta = { id: flow.id, key: 'k_write', span_id: start?.['span_id'] }
      const recorded = events
        .filter((e) => e.kind === 'checkpoint')
        .map(({ run_id: _run_id, ts: _ts, ...rest }) => rest)
      expect(recorded).toStrictEqual([
        { kind: 'checkpoint', status: 'miss', ...meta },
        { kind: 'checkpoint', status: 'write_error', error: message, ...meta },
      ])
    },
  )

  it('returns the inner result after a failed write under on_write_error: record', async () => {
    const { logger, events } = recording_logger()
    const flow = checkpoint(step('add_one', (x: number) => x + 1), {
      key: 'k_record',
      on_write_error: 'record',
    })

    const result = await run(flow, 5, {
      checkpoint_store: failing_writes(new Error('disk full')),
      trajectory: logger,
      install_signal_handlers: false,
    })

    expect(result).toBe(6)
    const statuses = events.filter((e) => e.kind === 'checkpoint').map((e) => e['status'])
    expect(statuses).toEqual(['miss', 'write_error'])
  })

  it('records write_error and then throws the store error under on_write_error: fail', async () => {
    const { logger, events } = recording_logger()
    const failure = new Error('disk full')
    const flow = checkpoint(step('add_one', (x: number) => x + 1), {
      key: 'k_fail',
      on_write_error: 'fail',
    })

    await expect(
      run(flow, 5, {
        checkpoint_store: failing_writes(failure),
        trajectory: logger,
        install_signal_handlers: false,
      }),
    ).rejects.toBe(failure)
    const recorded = events.filter((e) => e.kind === 'checkpoint')
    expect(recorded.map((e) => e['status'])).toEqual(['miss', 'write_error'])
    expect(recorded[1]?.['error']).toBe('disk full')
  })

  it('keeps on_write_error out of its config, so describe shows the same step', () => {
    const strict = checkpoint(step('a', (n: number) => n), { key: 'k', on_write_error: 'fail' })
    expect(strict.config).toStrictEqual({ key: 'k' })
  })

  it('records read_error and then throws the store error under on_read_error: fail, without running inner', async () => {
    const { logger, events } = recording_logger()
    const failure = new Error('disk unavailable')
    const spy = vi.fn((x: number) => x + 1)
    const set = vi.fn(async () => {})
    const flow = checkpoint(step('add_one', spy), { key: 'k_read_fail', on_read_error: 'fail' })
    const store: CheckpointStore = {
      async get() {
        throw failure
      },
      set,
      async delete() {
        // noop
      },
    }

    await expect(
      run(flow, 5, { checkpoint_store: store, trajectory: logger, install_signal_handlers: false }),
    ).rejects.toBe(failure)
    expect(spy).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'checkpoint')
    const recorded = events
      .filter((e) => e.kind === 'checkpoint')
      .map(({ run_id: _run_id, ts: _ts, ...rest }) => rest)
    expect(recorded).toStrictEqual([
      {
        kind: 'checkpoint',
        status: 'read_error',
        error: 'disk unavailable',
        id: flow.id,
        key: 'k_read_fail',
        span_id: start?.['span_id'],
      },
    ])
  })

  it('serves a hit and runs inner on a plain miss under on_read_error: fail', async () => {
    const { logger, events } = recording_logger()
    const spy = vi.fn((x: number) => x + 1)
    const flow = checkpoint(step('add_one', spy), {
      key: (n: number) => `k_${n}`,
      on_read_error: 'fail',
    })
    const store = memory_store()
    store.data.set('k_1', 42)
    const options = { checkpoint_store: store, trajectory: logger, install_signal_handlers: false }

    expect(await run(flow, 1, options)).toBe(42)
    expect(spy).not.toHaveBeenCalled()
    expect(await run(flow, 5, options)).toBe(6)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(store.data.get('k_5')).toBe(6)
    expect(events.filter((e) => e.kind === 'checkpoint').map((e) => e['status'])).toEqual([
      'hit',
      'miss',
    ])
  })

  it('records read_error and still runs inner under on_read_error: miss', async () => {
    const { logger, events } = recording_logger()
    const flow = checkpoint(step('add_one', (x: number) => x + 1), {
      key: 'k_read_miss',
      on_read_error: 'miss',
    })
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

    expect(result).toBe(6)
    const lookups = events.filter((e) => e.kind === 'checkpoint')
    expect(lookups.map((e) => e['status'])).toEqual(['read_error'])
    expect(lookups[0]?.['error']).toBe('corrupted')
  })

  it('keeps on_read_error out of its config, so describe shows the same step', () => {
    const strict = checkpoint(step('a', (n: number) => n), { key: 'k', on_read_error: 'fail' })
    expect(strict.config).toStrictEqual({ key: 'k' })
  })

  it('counts a stored undefined as a miss and runs inner', async () => {
    const { logger, events } = recording_logger()
    const flow = checkpoint(step('add_one', (x: number) => x + 1), { key: 'k_undefined' })
    const store: CheckpointStore = {
      async get() {
        return undefined
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

    expect(result).toBe(6)
    expect(events.filter((e) => e.kind === 'checkpoint').map((e) => e['status'])).toEqual(['miss'])
  })

  it('records no checkpoint event when no store is configured', async () => {
    const { logger, events } = recording_logger()
    const flow = checkpoint(step('add_one', (x: number) => x + 1), { key: 'k_none' })

    await run(flow, 5, { trajectory: logger, install_signal_handlers: false })
    expect(events.filter((e) => e.kind === 'checkpoint')).toHaveLength(0)
  })
})

describe('checkpoint over a step tree that loops back on itself', () => {
  it('builds without walking the loop forever', () => {
    const children: AnyStep[] = []
    const cyclic: Step<number, number> = { id: 'cyclic', kind: 'step', run: (n: number) => n, children }
    children.push(cyclic)
    expect(() => checkpoint(cyclic, { key: 'k' })).not.toThrow()
  })
})
