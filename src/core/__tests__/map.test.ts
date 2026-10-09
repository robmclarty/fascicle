import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { aborted_error, suspended_error, timeout_error } from '../errors.js'
import { map } from '../map.js'
import { run } from '../runner.js'
import { step } from '../step.js'
import { suspend } from '../suspend.js'
import { is_map_item_failed_event } from '../trajectory.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'
import { remove_signal_listeners } from '../../../test/fixtures/signal_listeners.js'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const identity_items = (x: number[]): number[] => x

const QUIET = { install_signal_handlers: false } as const

// Throws on 2, returns ten times anything else, and notes every item it starts.
function tens_but_two(started: number[] = []) {
  return step('item', (v: number) => {
    started.push(v)
    if (v === 2) throw new Error('boom')
    return v * 10
  })
}

describe('map', () => {
  afterEach(remove_signal_listeners)

  it('never exceeds concurrency and preserves order (spec §10 test 18)', async () => {
    let in_flight = 0
    let peak = 0
  
    const flow = map({
      items: (x: number[]) => x,
      concurrency: 2,
      do: step('item', async (v: number) => {
        in_flight += 1
        if (in_flight > peak) peak = in_flight
        await wait(20)
        in_flight -= 1
        return v * 10
      }),
    })
  
    const result = await run(flow, [1, 2, 3, 4, 5])
  
    expect(result).toEqual([10, 20, 30, 40, 50])
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThanOrEqual(1)
  })

  it('runs with unbounded concurrency when omitted', async () => {
    const flow = map({
      items: (x: number[]) => x,
      do: step('item', async (v: number) => {
        await wait(10)
        return v + 1
      }),
    })
  
    const started = Date.now()
    const result = await run(flow, [1, 2, 3, 4, 5, 6])
    const elapsed = Date.now() - started
  
    expect(result).toEqual([2, 3, 4, 5, 6, 7])
    expect(elapsed).toBeLessThan(50)
  })

  it('emits a map span', async () => {
    const { logger, events } = recording_logger()
    const flow = map({
      items: (_x: number[]) => [1, 2],
      do: step('item', (v: number) => v),
    })
  
    await run(flow, [], { trajectory: logger, install_signal_handlers: false })
  
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'map')
    expect(start).toBeDefined()
  })

  it('propagates abort to in-flight items and rethrows', async () => {
    let aborted_count = 0
    let settled_count = 0
  
    const flow = map({
      items: (_: number) => [1, 2, 3, 4],
      concurrency: 4,
      do: step('item', async (_v: number, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.abort.aborted) {
            aborted_count += 1
            resolve()
            return
          }
          ctx.abort.addEventListener(
            'abort',
            () => {
              aborted_count += 1
              resolve()
            },
            { once: true },
          )
        })
        settled_count += 1
        return 0
      }),
    })
  
    const pending = run(flow, 0)
    await wait(20)
    process.emit('SIGINT')
  
    await expect(pending).rejects.toBeInstanceOf(aborted_error)
    expect(aborted_count).toBe(4)
    expect(settled_count).toBe(4)
  })

  it('handles empty item lists', async () => {
    const flow = map({
      items: (_x: number) => [],
      do: step('item', (v: number) => v),
    })
    await expect(run(flow, 0)).resolves.toEqual([])
  })

  it('propagates the first error when several items fail', async () => {
    const flow = map({
      items: (x: number[]) => x,
      concurrency: 2,
      do: step('item', async (v: number) => {
        if (v === 1) throw new Error('first')
        await wait(10)
        throw new Error('second')
      }),
    })
    await expect(run(flow, [1, 2], { install_signal_handlers: false })).rejects.toThrow('first')
  })

  it('rejects when an item step throws', async () => {
    const flow = map({
      items: (x: number[]) => x,
      do: step('item', (v: number) => {
        if (v === 2) throw new Error('boom')
        return v
      }),
    })
    await expect(run(flow, [1, 2, 3], { install_signal_handlers: false })).rejects.toThrow('boom')
  })

  it('wraps a non-Error abort reason in aborted_error', async () => {
    const ctrl = new AbortController()
    const flow = map({
      items: (x: number[]) => x,
      concurrency: 2,
      do: step('item', async (v: number, ctx) => {
        await new Promise<void>((_resolve, reject) => {
          ctx.abort.addEventListener('abort', () => reject(ctx.abort.reason), { once: true })
        })
        return v
      }),
    })
    const pending = run(flow, [1, 2], { abort: ctrl.signal, install_signal_handlers: false })
    await wait(20)
    ctrl.abort('stop-now')
    const err = await pending.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(aborted_error)
    if (err instanceof aborted_error) {
      expect(err.message).toBe('aborted')
      expect(err.reason).toBe('stop-now')
    }
  })

  it('exposes a map step shape with id, children, and config', () => {
    const per = step('item', (v: number) => v)
    const flow = map({ name: 'each', items: identity_items, do: per, concurrency: 2 })
    expect(flow.id).toMatch(/^map_\d+$/)
    expect(flow.kind).toBe('map')
    expect(flow.children).toEqual([per])
    expect(flow.config?.['items']).toBe(identity_items)
    expect(flow.config?.['concurrency']).toBe(2)
    expect(flow.config?.['display_name']).toBe('each')
  })

  it('omits concurrency and display_name when not provided', () => {
    const flow = map({ items: (x: number[]) => x, do: step('item', (v: number) => v) })
    expect(flow.config !== undefined && 'concurrency' in flow.config).toBe(false)
    expect(flow.config !== undefined && 'display_name' in flow.config).toBe(false)
    expect(flow.config !== undefined && 'settle' in flow.config).toBe(false)
  })
})

describe('map with settle', () => {
  afterEach(remove_signal_listeners)

  it('keeps every outcome in input order, failures included', async () => {
    const flow = map({ items: identity_items, do: tens_but_two(), settle: true })
    expect(await run(flow, [1, 2, 3], QUIET)).toStrictEqual([
      { ok: true, value: 10 },
      { ok: false, error: { message: 'boom', name: 'Error', path: ['item'] } },
      { ok: true, value: 30 },
    ])
  })

  it('keeps starting items after one fails, where a plain map stops', async () => {
    const plain_started: number[] = []
    const plain = map({ items: identity_items, do: tens_but_two(plain_started), concurrency: 1 })
    await expect(run(plain, [2, 3, 4], QUIET)).rejects.toThrow('boom')
    expect(plain_started).toEqual([2])

    const settled_started: number[] = []
    const settled = map({
      items: identity_items,
      do: tens_but_two(settled_started),
      concurrency: 1,
      settle: true,
    })
    await run(settled, [2, 3, 4], QUIET)
    expect(settled_started).toEqual([2, 3, 4])
  })

  it('treats settle: false as the plain map it is', async () => {
    const flow = map({ items: identity_items, do: tens_but_two(), settle: false })
    await expect(run(flow, [1, 2], QUIET)).rejects.toThrow('boom')
    expect(flow.config !== undefined && 'settle' in flow.config).toBe(false)
  })

  it("keeps an error's kind, which is how to tell failures apart", async () => {
    const flow = map({
      items: identity_items,
      settle: true,
      do: step('item', (v: number): number => {
        throw new timeout_error(`item ${v} took too long`, 50)
      }),
    })
    expect(await run(flow, [7], QUIET)).toStrictEqual([
      {
        ok: false,
        error: {
          message: 'item 7 took too long',
          name: 'timeout_error',
          kind: 'timeout_error',
          path: ['item'],
        },
      },
    ])
  })

  it('leaves out a name the error does not have', async () => {
    const flow = map({
      items: identity_items,
      settle: true,
      do: step('item', (_: number): number => {
        const err = new Error('nameless')
        err.name = ''
        throw err
      }),
    })
    expect(await run(flow, [1], QUIET)).toStrictEqual([
      { ok: false, error: { message: 'nameless', path: ['item'] } },
    ])
  })

  it('leaves out a path that a frozen error could not take', async () => {
    const flow = map({
      items: identity_items,
      settle: true,
      do: step('item', (_: number): number => {
        throw Object.freeze(new Error('frozen'))
      }),
    })
    expect(await run(flow, [1], QUIET)).toStrictEqual([
      { ok: false, error: { message: 'frozen', name: 'Error' } },
    ])
  })

  it('keeps only the string form of a thrown value that is not an Error', async () => {
    const flow = map({
      items: identity_items,
      settle: true,
      do: step('item', (_: number): number => {
        // A step can throw anything; the slot keeps its string form.
        // oxlint-disable-next-line no-throw-literal
        throw 'plain string'
      }),
    })
    expect(await run(flow, [1], QUIET)).toStrictEqual([{ ok: false, error: { message: 'plain string' } }])
  })

  it('records a map_item_failed event for each failed item, with the kind when there is one', async () => {
    const { logger, events } = recording_logger()
    const flow = map({
      items: identity_items,
      concurrency: 1,
      settle: true,
      do: step('item', (v: number) => {
        if (v === 2) throw new Error('boom')
        if (v === 3) throw new timeout_error('slow', 5)
        return v
      }),
    })
    await run(flow, [1, 2, 3], { ...QUIET, trajectory: logger })
    const failed = events
      .filter(is_map_item_failed_event)
      .map(({ ts: _ts, run_id: _run_id, ...event }) => event)
    expect(failed).toStrictEqual([
      { kind: 'map_item_failed', step_id: flow.id, index: 1, error: 'boom' },
      { kind: 'map_item_failed', step_id: flow.id, index: 2, error: 'slow', error_kind: 'timeout_error' },
    ])
  })

  it('lets a suspend through rather than settling it, and resumes into settled values', async () => {
    const flow = map({
      items: identity_items,
      settle: true,
      do: suspend({
        id: 'approve',
        on: () => {},
        resume_schema: z.object({ ok: z.boolean() }),
        combine: (v: number, decision) => (decision.ok ? v : -v),
      }),
    })
    await expect(run(flow, [1, 2], QUIET)).rejects.toBeInstanceOf(suspended_error)
    expect(await run(flow, [1, 2], { ...QUIET, resume_data: { approve: { ok: true } } })).toStrictEqual([
      { ok: true, value: 1 },
      { ok: true, value: 2 },
    ])
  })

  it('throws the abort instead of settling the items it interrupted', async () => {
    const ctrl = new AbortController()
    const { logger, events } = recording_logger()
    const flow = map({
      items: identity_items,
      settle: true,
      do: step('item', async (_: number, ctx) => {
        await new Promise<void>((_resolve, reject) => {
          ctx.abort.addEventListener('abort', () => reject(new Error('request cancelled')), { once: true })
        })
        return 0
      }),
    })
    const pending = run(flow, [1, 2], { ...QUIET, abort: ctrl.signal, trajectory: logger })
    await wait(20)
    ctrl.abort(new Error('shutting down'))
    await expect(pending).rejects.toThrow('shutting down')
    expect(events.filter(is_map_item_failed_event)).toEqual([])
  })

  it('lets an error from items itself through', async () => {
    const flow = map({
      items: (_: number): number[] => {
        throw new Error('no list')
      },
      settle: true,
      do: step('item', (v: number) => v),
    })
    await expect(run(flow, 0, QUIET)).rejects.toThrow('no list')
  })

  it('records settle in the step config', () => {
    const flow = map({ items: identity_items, do: step('item', (v: number) => v), settle: true })
    expect(flow.config?.['settle']).toBe(true)
  })
})
