import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { checkpoint } from '../checkpoint.js'
import { durable, type DurableStore } from '../durable.js'
import {
  aborted_error,
  flow_changed_error,
  resume_validation_error,
  run_not_found_error,
} from '../errors.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'
import { suspend } from '../suspend.js'
import type { Step, TrajectoryEvent } from '../types.js'
import { memory_store, type MemoryStore } from '../../../test/fixtures/memory_store.js'
import { remove_signal_listeners } from '../../../test/fixtures/signal_listeners.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'

const QUIET = { install_signal_handlers: false } as const

// A gate that resumes on `{ ok }`, appending its id to the input either way.
function gate(id: string, options: { deadline_ms?: number; on?: () => void } = {}) {
  return suspend({
    id,
    ...(options.deadline_ms === undefined ? {} : { deadline_ms: options.deadline_ms }),
    on: options.on ?? (() => {}),
    resume_schema: z.object({ ok: z.boolean() }),
    combine: (input: string, resume) => `${input}${resume.ok ? '+' : '-'}${id}`,
  })
}

// A step that counts its runs and tags its input with its id.
function counted(id: string, runs: { n: number }) {
  return step(id, (input: string) => {
    runs.n += 1
    return `${input}>${id}`
  })
}

// A value after a trip through JSON, which is how most stores keep it.
function as_json(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The record the driver keeps for `run_id`.
function record_of(store: MemoryStore, run_id: string): Promise<unknown> {
  return store.scope(run_id).get('record')
}

// The record `run_id` would have had under a driver from before the inbox
// moved into the record: `format: 1`, with no inbox of its own.
async function as_format_1(store: MemoryStore, run_id: string): Promise<void> {
  const { inbox: _, ...rest } = (await record_of(store, run_id)) as Record<string, unknown>
  await store.scope(run_id).set('record', { ...rest, format: 1 })
}

// A store whose first conditional write of a record that `matches` waits
// until `release` is called, so a test can hold one writer between its read
// of the record and its write while other calls move the run on. `held`
// settles once that write is waiting.
function holding_write(base: MemoryStore, matches: (record: Record<string, unknown>) => boolean) {
  const held = Promise.withResolvers<void>()
  const go = Promise.withResolvers<void>()
  let waiting = false
  const store: DurableStore = {
    scope: (prefix) => {
      const scope = base.scope(prefix)
      return {
        ...scope,
        set_if: async (key, value, expected) => {
          if (key === 'record' && !waiting && matches(value as Record<string, unknown>)) {
            waiting = true
            held.resolve()
            await go.promise
          }
          return scope.set_if(key, value, expected)
        },
      }
    },
  }
  return { store, held: held.promise, release: () => go.resolve() }
}

// True for a record whose inbox holds `{ ok }` for `gate_id`, which is the
// write a delivery of that datum makes.
function delivers(gate_id: string, ok: boolean) {
  return (record: Record<string, unknown>): boolean => {
    const inbox = record['inbox'] as Record<string, { data: { ok: boolean } }>
    return inbox[gate_id]?.data.ok === ok
  }
}

afterEach(() => {
  remove_signal_listeners()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('durable: a run from start to finish', () => {
  it('drives a flow that never suspends to done, and remembers it', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = step('double', (n: number) => n * 2)
    expect(await runs.start('r1', flow, 21, QUIET)).toEqual({ kind: 'done', run_id: 'r1', output: 42 })
    expect(await runs.get('r1')).toEqual({ kind: 'done', run_id: 'r1', output: 42 })
  })

  it('reports where a run waits, and resumes it from an event in a later call', async () => {
    const store = memory_store()
    const prefix = { n: 0 }
    const flow = sequence([counted('draft', prefix), gate('approve')])
    const suspended = await durable({ store }).start('r1', flow, 'in', QUIET)
    expect(suspended).toStrictEqual({
      kind: 'suspended',
      run_id: 'r1',
      id: 'approve',
      payload: { input: 'in>draft' },
    })
    expect(await record_of(store, 'r1')).toMatchObject({ revision: 1 })
    // A fresh driver over the same store stands in for a new process.
    const resumed = await durable({ store }).resume('r1', flow, { approve: { ok: true } }, QUIET)
    expect(resumed).toEqual({ kind: 'done', run_id: 'r1', output: 'in>draft+approve' })
    expect(prefix.n).toBe(2)
    // One write for taking up the decision, one for where the drive ended.
    expect(await record_of(store, 'r1')).toMatchObject({ revision: 3 })
  })

  it('walks a run through two gates, carrying each decision into the next drive', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('first'), gate('second')])
    expect(await runs.start('r', flow, 'go', QUIET)).toMatchObject({ kind: 'suspended', id: 'first' })
    expect(await runs.resume('r', flow, { first: { ok: true } }, QUIET)).toMatchObject({
      kind: 'suspended',
      id: 'second',
      payload: { input: 'go+first' },
    })
    expect(await runs.resume('r', flow, { second: { ok: false } }, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'go+first-second',
    })
  })

  it("gives the flow the run's own checkpoint store, apart from every other run", async () => {
    const store = memory_store()
    const runs = durable({ store })
    const work = { n: 0 }
    const flow = sequence([checkpoint(counted('work', work), { key: 'work' }), gate('approve')])
    await runs.start('a', flow, 'in', QUIET)
    await runs.start('b', flow, 'in', QUIET)
    expect(work.n).toBe(2)
    await runs.resume('a', flow, { approve: { ok: true } }, QUIET)
    expect(work.n).toBe(2)
    expect(await store.scope('a').scope('flow').get('work')).toBe('in>work')
  })

  it('hands even the first drive its input as the store keeps it', async () => {
    const base = memory_store()
    // A store that keeps values as JSON, the way most stores do.
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          set_if: (key, value, expected) => scope.set_if(key, as_json(value), expected),
        }
      },
    }
    const seen: unknown[] = []
    const flow = step('look', (input: { at: unknown }) => {
      seen.push(input.at)
      return 'looked'
    })
    await durable({ store }).start('r', flow, { at: new Date(0) }, QUIET)
    expect(seen).toEqual(['1970-01-01T00:00:00.000Z'])
  })

  it("passes the caller's run options through to every drive", async () => {
    const { logger, events } = recording_logger()
    const runs = durable({ store: memory_store() })
    await runs.start('r', step('one', () => 1), null, { ...QUIET, trajectory: logger })
    expect(events.some((e) => e.kind === 'run_end')).toBe(true)
  })

  it("aborts a drive when the caller's signal fires, and marks the run failed", async () => {
    const runs = durable({ store: memory_store() })
    const controller = new AbortController()
    const flow = step('wait', async (_: null, ctx) => {
      controller.abort(new aborted_error('caller gave up'))
      await sleep(5)
      if (ctx.abort.aborted) throw ctx.abort.reason
      return 'finished'
    })
    await expect(runs.start('r', flow, null, { ...QUIET, abort: controller.signal })).rejects.toThrow(
      'caller gave up',
    )
    expect(await runs.get('r')).toEqual({ kind: 'failed', run_id: 'r', error: 'caller gave up' })
  })
})

describe('durable: repeated and stray events', () => {
  it("treats a repeated start as a no-op that reports where the run is, ignoring the new input", async () => {
    const store = memory_store()
    const runs = durable({ store })
    const notified = { n: 0 }
    const flow = sequence([counted('draft', { n: 0 }), gate('approve', { on: () => void (notified.n += 1) })])
    await runs.start('r', flow, 'first input', QUIET)
    const again = await runs.start('r', flow, 'second input', QUIET)
    expect(again).toMatchObject({ kind: 'suspended', id: 'approve', payload: { input: 'first input>draft' } })
    expect(notified.n).toBe(1)
  })

  it('reports a finished run as done to a repeated start or a late resume', async () => {
    const runs = durable({ store: memory_store() })
    const flow = sequence([gate('approve')])
    await runs.start('r', flow, 'in', QUIET)
    await runs.resume('r', flow, { approve: { ok: true } }, QUIET)
    const done = { kind: 'done', run_id: 'r', output: 'in+approve' }
    expect(await runs.start('r', flow, 'in', QUIET)).toEqual(done)
    expect(await runs.resume('r', flow, { approve: { ok: false } }, QUIET)).toEqual(done)
  })

  it('drops data for a gate the run already passed', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('first'), gate('second')])
    await runs.start('r', flow, 'go', QUIET)
    await runs.resume('r', flow, { first: { ok: true } }, QUIET)
    const stale = await runs.resume('r', flow, { first: { ok: false } }, QUIET)
    expect(stale).toMatchObject({ kind: 'suspended', id: 'second', payload: { input: 'go+first' } })
    expect(await record_of(store, 'r')).toMatchObject({ inbox: {}, resume_data: { first: { ok: true } } })
  })

  it('keeps data for a gate the run has yet to reach, and spends it there', async () => {
    const runs = durable({ store: memory_store() })
    const later_notified = { n: 0 }
    const flow = sequence([gate('first'), gate('second', { on: () => void (later_notified.n += 1) })])
    await runs.start('r', flow, 'go', QUIET)
    const early = await runs.resume('r', flow, { second: { ok: true } }, QUIET)
    expect(early).toMatchObject({ kind: 'suspended', id: 'first' })
    const done = await runs.resume('r', flow, { first: { ok: true } }, QUIET)
    expect(done).toEqual({ kind: 'done', run_id: 'r', output: 'go+first+second' })
    // The run stopped at the second gate only long enough to take up its data.
    expect(later_notified.n).toBe(1)
  })

  it('resumes nothing with an undefined datum', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const notified = { n: 0 }
    const flow = sequence([gate('approve', { on: () => void (notified.n += 1) })])
    await runs.start('r', flow, 'in', QUIET)
    const before = await record_of(store, 'r')
    expect(await runs.resume('r', flow, { approve: undefined }, QUIET)).toMatchObject({
      kind: 'suspended',
      id: 'approve',
    })
    expect(before).toMatchObject({ inbox: {} })
    expect(await record_of(store, 'r')).toStrictEqual(before)
    // The run never moved, so the gate never asked again.
    expect(notified.n).toBe(1)
  })

  it('keeps a datum whose gate id is also an Object.prototype name', async () => {
    const runs = durable({ store: memory_store() })
    const flow = sequence([gate('toString')])
    await runs.start('r', flow, 'in', QUIET)
    expect(await runs.resume('r', flow, { toString: { ok: true } }, QUIET)).toMatchObject({
      kind: 'done',
      output: 'in+toString',
    })
  })

  it('refuses to resume a run it has never seen', async () => {
    const runs = durable({ store: memory_store() })
    const err: unknown = await runs
      .resume('ghost', gate('approve'), { approve: { ok: true } }, QUIET)
      .catch((caught: unknown) => caught)
    expect(err).toBeInstanceOf(run_not_found_error)
    expect(err).toMatchObject({
      run_id: 'ghost',
      message: 'no durable run ghost: start it before resuming it',
    })
  })

  it('refuses an empty run id', async () => {
    const runs = durable({ store: memory_store() })
    const refused = new TypeError('durable: a run id must be a non-empty string')
    const flow = sequence([gate('approve')])
    await expect(runs.get('')).rejects.toThrow(refused)
    await expect(runs.start('', flow, 'in', QUIET)).rejects.toThrow(refused)
    await expect(runs.resume('', flow, {}, QUIET)).rejects.toThrow(refused)
    await expect(runs.delete('')).rejects.toThrow(refused)
  })
})

describe('durable: one drive at a time', () => {
  it('reports busy, and leaves the data in the inbox, while another drive holds the run', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('approve')])
    await runs.start('r', flow, 'in', QUIET)
    await store.scope('r').claim('lease', 'someone else', 60_000)
    expect(await runs.resume('r', flow, { approve: { ok: true } }, QUIET)).toEqual({
      kind: 'busy',
      run_id: 'r',
    })
    expect(await runs.start('r', flow, 'in', QUIET)).toEqual({ kind: 'busy', run_id: 'r' })
    // The delivery changed the inbox and left the revision to the drives.
    expect(await record_of(store, 'r')).toMatchObject({
      revision: 1,
      inbox: { approve: { data: { ok: true } } },
    })
    await store.scope('r').release('lease', 'someone else')
    // A resume with nothing new still drives, and takes up what waited.
    expect(await runs.resume('r', flow, {}, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'in+approve',
    })
  })

  it('gives a gate the first data to reach it while the run is busy', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('ci')])
    await runs.start('r', flow, 'pr', QUIET)
    await store.scope('r').claim('lease', 'someone else', 60_000)
    expect(await runs.resume('r', flow, { ci: { ok: true } }, QUIET)).toMatchObject({ kind: 'busy' })
    expect(await runs.resume('r', flow, { ci: { ok: false } }, QUIET)).toMatchObject({ kind: 'busy' })
    await store.scope('r').release('lease', 'someone else')
    expect(await runs.resume('r', flow, {}, QUIET)).toEqual({ kind: 'done', run_id: 'r', output: 'pr+ci' })
  })

  it('gives a gate the first datum when two resumes race for it', async () => {
    const base = memory_store()
    // A read of the record answers late with what it saw, so two resumes that
    // read before they write both see an empty inbox before either one writes.
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          get_versioned: async (key) => {
            const read = await scope.get_versioned(key)
            await sleep(20)
            return read
          },
        }
      },
    }
    const runs = durable({ store })
    const flow = sequence([gate('ci')])
    await runs.start('r', flow, 'pr', QUIET)
    await base.scope('r').claim('lease', 'someone else', 60_000)
    const raced = await Promise.all([
      runs.resume('r', flow, { ci: { ok: true } }, QUIET),
      runs.resume('r', flow, { ci: { ok: false } }, QUIET),
    ])
    expect(raced).toEqual([
      { kind: 'busy', run_id: 'r' },
      { kind: 'busy', run_id: 'r' },
    ])
    expect(await record_of(base, 'r')).toMatchObject({ inbox: { ci: { data: { ok: true } } } })
    await base.scope('r').release('lease', 'someone else')
    expect(await runs.resume('r', flow, {}, QUIET)).toEqual({ kind: 'done', run_id: 'r', output: 'pr+ci' })
  })

  it('drops a datum whose delivery stalled while another resume moved the run past its gate', async () => {
    const base = memory_store()
    // The late delivery has read the record and decided to write when it stalls.
    const { store, held, release } = holding_write(base, delivers('first', false))
    const runs = durable({ store })
    const flow = sequence([gate('first'), gate('second')])
    await runs.start('r', flow, 'go', QUIET)
    const late = runs.resume('r', flow, { first: { ok: false } }, QUIET)
    await held
    expect(await runs.resume('r', flow, { first: { ok: true } }, QUIET)).toMatchObject({
      kind: 'suspended',
      id: 'second',
    })
    const moved_on = await record_of(base, 'r')
    release()
    expect(await late).toMatchObject({ kind: 'suspended', id: 'second', payload: { input: 'go+first' } })
    expect(moved_on).toMatchObject({ inbox: {}, resume_data: { first: { ok: true } } })
    expect(await record_of(base, 'r')).toStrictEqual(moved_on)
  })

  it('drops a datum whose run was deleted while its delivery stalled, so a new run under the id starts clean', async () => {
    const base = memory_store()
    const { store, held, release } = holding_write(base, delivers('first', true))
    const runs = durable({ store })
    const flow = sequence([gate('first'), gate('second')])
    await runs.start('r', flow, 'old', QUIET)
    const late = runs.resume('r', flow, { first: { ok: true } }, QUIET)
    await held
    expect(await runs.delete('r')).toBe(true)
    release()
    await expect(late).rejects.toBeInstanceOf(run_not_found_error)
    expect(base.dump()).toEqual({})
    expect(await runs.start('r', flow, 'new', QUIET)).toStrictEqual({
      kind: 'suspended',
      run_id: 'r',
      id: 'first',
      payload: { input: 'new' },
    })
    expect(await record_of(base, 'r')).toMatchObject({ inbox: {}, resume_data: {} })
  })

  it('delivers without a claim, taking nothing but the lease', async () => {
    const base = memory_store()
    const claimed: string[] = []
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          claim: (key, owner, ttl_ms) => {
            claimed.push(key)
            return scope.claim(key, owner, ttl_ms)
          },
        }
      },
    }
    const runs = durable({ store })
    const flow = sequence([gate('ci')])
    await runs.start('r', flow, 'pr', QUIET)
    // A claim that a resume from before the inbox moved left on its gate.
    await base.scope('r').claim('inbox/ci', 'a resume that died', 60_000)
    expect(await runs.resume('r', flow, { ci: { ok: true } }, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'pr+ci',
    })
    expect(new Set(claimed)).toEqual(new Set(['lease']))
  })

  it('delivers each datum of one call, one write after another', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('first'), gate('second'), gate('third')])
    await runs.start('r', flow, 'go', QUIET)
    await store.scope('r').claim('lease', 'someone else', 60_000)
    const all = { third: { ok: true }, second: { ok: false }, first: { ok: true } }
    expect(await runs.resume('r', flow, all, QUIET)).toEqual({ kind: 'busy', run_id: 'r' })
    expect(await record_of(store, 'r')).toMatchObject({
      inbox: { first: { data: { ok: true } }, second: { data: { ok: false } }, third: { data: { ok: true } } },
    })
    await store.scope('r').release('lease', 'someone else')
    expect(await runs.resume('r', flow, {}, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'go+first-second+third',
    })
    expect(await record_of(store, 'r')).toMatchObject({ inbox: {} })
  })

  it("keeps a delivery that lands between a drive's read of the record and its write", async () => {
    const base = memory_store()
    // The drive has read the record and is about to save where it stopped.
    const { store, held, release } = holding_write(base, (record) => record['status'] === 'suspended')
    const runs = durable({ store })
    const flow = sequence([gate('approve')])
    const first = runs.start('r', flow, 'in', QUIET)
    await held
    expect(await durable({ store: base }).resume('r', flow, { approve: { ok: true } }, QUIET)).toEqual({
      kind: 'busy',
      run_id: 'r',
    })
    release()
    // The save lost to the delivery, wrote again with it kept, and took it up.
    expect(await first).toEqual({ kind: 'done', run_id: 'r', output: 'in+approve' })
    expect(await record_of(base, 'r')).toMatchObject({ status: 'done', inbox: {}, revision: 3 })
  })

  it('moves a datum from the inbox into the resume data in one write, and leaves the rest of the inbox', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const seen: unknown[] = []
    const flow = sequence([
      gate('first'),
      step('look', async (s: string) => {
        seen.push(await record_of(store, 'r'))
        return s
      }),
      gate('second'),
    ])
    await runs.start('r', flow, 'go', QUIET)
    await runs.resume('r', flow, { second: { ok: true } }, QUIET)
    expect(await runs.resume('r', flow, { first: { ok: true } }, QUIET)).toMatchObject({
      kind: 'done',
      output: 'go+first+second',
    })
    // What the store held while the drive that took `first` up was running.
    expect(seen[0]).toMatchObject({ status: 'running', resume_data: { first: { ok: true } } })
    expect((seen[0] as { inbox: unknown }).inbox).toStrictEqual({ second: { data: { ok: true } } })
  })

  it('reports a finished run as done even while another call holds it', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('approve')])
    await runs.start('r', flow, 'in', QUIET)
    await runs.resume('r', flow, { approve: { ok: true } }, QUIET)
    await store.scope('r').claim('lease', 'someone else', 60_000)
    expect(await runs.resume('r', flow, { approve: { ok: true } }, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'in+approve',
    })
  })

  it('spends an event that landed mid-drive before letting the run go', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const blocked = Promise.withResolvers<void>()
    const flow = sequence([
      step('slow', async (s: string) => {
        await blocked.promise
        return s
      }),
      gate('approve'),
    ])
    const first = runs.start('r', flow, 'in', QUIET)
    while ((await runs.get('r')) === undefined) await sleep(1)
    expect(await runs.resume('r', flow, { approve: { ok: true } }, QUIET)).toEqual({
      kind: 'busy',
      run_id: 'r',
    })
    blocked.resolve()
    expect(await first).toEqual({ kind: 'done', run_id: 'r', output: 'in+approve' })
  })

  it('looks at the inbox again after letting the run go, and drives on when an event waits', async () => {
    const base = memory_store()
    let landed = false
    // An event that lands at the last moment, as the drive lets the lease go.
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          release: async (key, owner) => {
            const record = (await scope.get('record')) as { status: string } | null
            if (!landed && record?.status === 'suspended') {
              landed = true
              await scope.set('record', { ...record, inbox: { approve: { data: { ok: true } } } })
            }
            await scope.release(key, owner)
          },
        }
      },
    }
    const runs = durable({ store })
    const flow = sequence([gate('approve')])
    expect(await runs.start('r', flow, 'in', QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'in+approve',
    })
    expect(landed).toBe(true)
  })

  it('reports busy when another call takes the run between its two drives', async () => {
    const base = memory_store()
    let stolen = false
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          release: async (key, owner) => {
            await scope.release(key, owner)
            if (stolen) return
            stolen = true
            const record = (await scope.get('record')) as Record<string, unknown>
            await scope.set('record', { ...record, inbox: { approve: { data: { ok: true } } } })
            await scope.claim('lease', 'the other call', 60_000)
          },
        }
      },
    }
    const runs = durable({ store })
    expect(await runs.start('r', sequence([gate('approve')]), 'in', QUIET)).toEqual({
      kind: 'busy',
      run_id: 'r',
    })
  })

  it('reports where the run stopped when the run is deleted as the drive lets it go', async () => {
    const base = memory_store()
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          release: async (key, owner) => {
            await scope.release(key, owner)
            await scope.clear()
          },
        }
      },
    }
    expect(await durable({ store }).start('r', sequence([gate('approve')]), 'in', QUIET)).toMatchObject({
      kind: 'suspended',
      id: 'approve',
    })
  })

  it('reports where the run stopped when what waits in the inbox is for another gate', async () => {
    const base = memory_store()
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          release: async (key, owner) => {
            const record = (await scope.get('record')) as Record<string, unknown>
            await scope.set('record', { ...record, inbox: { second: { data: { ok: true } } } })
            await scope.release(key, owner)
          },
        }
      },
    }
    const notified = { n: 0 }
    const flow = sequence([gate('first', { on: () => void (notified.n += 1) }), gate('second')])
    expect(await durable({ store }).start('r', flow, 'in', QUIET)).toMatchObject({
      kind: 'suspended',
      id: 'first',
    })
    expect(notified.n).toBe(1)
  })
})

describe('durable: leases', () => {
  it('claims each run for sixty seconds by default, renewing every third of that', async () => {
    const base = memory_store()
    const ttls: number[] = []
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          claim: (key, owner, ttl_ms) => {
            ttls.push(ttl_ms)
            return scope.claim(key, owner, ttl_ms)
          },
        }
      },
    }
    const unref = vi.fn()
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(
      () => ({ unref }) as unknown as ReturnType<typeof setInterval>,
    )
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {})
    await durable({ store }).start('r', step('one', () => 1), null, QUIET)
    expect(ttls.every((ttl) => ttl === 60_000)).toBe(true)
    expect(ttls.length).toBeGreaterThan(0)
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 20_000)
    expect(unref).toHaveBeenCalled()
  })

  it('refuses a lease that is not a positive number of milliseconds', () => {
    for (const lease_ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => durable({ store: memory_store(), lease_ms })).toThrow(
        new RangeError(`durable: lease_ms must be a positive number of milliseconds, got ${lease_ms}`),
      )
    }
  })

  it('keeps the run while a long step outlasts the lease, by renewing it', async () => {
    const store = memory_store()
    const runs = durable({ store, lease_ms: 100 })
    const flow = step('long', async (_: null, ctx) => {
      await sleep(300)
      if (ctx.abort.aborted) throw ctx.abort.reason
      return 'finished'
    })
    const first = runs.start('r', flow, null, QUIET)
    await sleep(200)
    expect(await store.scope('r').claim('lease', 'intruder', 60_000)).toBe(false)
    expect(await first).toEqual({ kind: 'done', run_id: 'r', output: 'finished' })
  })

  it('stops a drive that lost its lease, and leaves the record to the new holder', async () => {
    const base = memory_store()
    let claims = 0
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          // The first renewal finds the lease taken. Later claims would get it
          // back, which a drive that has lost its lease must never act on.
          claim: async (key, owner, ttl_ms) => {
            claims += 1
            return claims === 2 ? false : scope.claim(key, owner, ttl_ms)
          },
        }
      },
    }
    const after = { n: 0 }
    const flow = sequence([
      step('long', async (s: string) => {
        await sleep(100)
        return s
      }),
      counted('after', after),
    ])
    const { logger, events } = recording_logger()
    const outcome = await durable({ store, lease_ms: 30 }).start('r', flow, 'in', {
      ...QUIET,
      trajectory: logger,
    })
    expect(outcome).toEqual({ kind: 'busy', run_id: 'r' })
    expect(after.n).toBe(0)
    expect(await record_of(base, 'r')).toMatchObject({ status: 'running', revision: 0 })
    expect(events.find((e) => e.kind === 'run_end')).toMatchObject({
      status: 'aborted',
      error: 'another drive took over this run',
    })
  })

  it("won't write over a drive that moved the run on while this one stalled", async () => {
    const store = memory_store()
    const runs = durable({ store })
    const stalled = Promise.withResolvers<void>()
    const in_step = Promise.withResolvers<void>()
    const flow = step('stall', async () => {
      in_step.resolve()
      await stalled.promise
      return 'stale result'
    })
    const first = runs.start('r', flow, null, QUIET)
    await in_step.promise
    // Another drive took the run over and finished it while this one stalled.
    const record = (await record_of(store, 'r')) as Record<string, unknown>
    const moved_on = { ...record, revision: 7, status: 'done', output: 'the other drive' }
    await store.scope('r').set('record', moved_on)
    stalled.resolve()
    expect(await first).toEqual({ kind: 'busy', run_id: 'r' })
    expect(await record_of(store, 'r')).toEqual(moved_on)
  })

  it("won't write over a drive that saved after this one read the record and before it wrote", async () => {
    const base = memory_store()
    // The drive has confirmed its lease and read the record at the revision
    // it expects when it stalls, with its write still to make.
    const { store, held, release } = holding_write(base, (record) => record['status'] === 'done')
    const first = durable({ store }).start('r', step('stall', () => 'stale result'), null, QUIET)
    await held
    // Past the stalled drive's lease, another drive took the run and saved.
    const record = (await record_of(base, 'r')) as Record<string, unknown>
    const moved_on = { ...record, revision: 1, status: 'done', output: 'the other drive' }
    await base.scope('r').set('record', moved_on)
    release()
    expect(await first).toEqual({ kind: 'busy', run_id: 'r' })
    expect(await record_of(base, 'r')).toEqual(moved_on)
  })

  it('gives up a drive whose run was deleted between its read of the record and its write', async () => {
    const base = memory_store()
    const { store, held, release } = holding_write(base, (record) => record['status'] === 'done')
    const first = durable({ store }).start('r', step('stall', () => 'orphaned'), null, QUIET)
    await held
    await base.scope('r').delete('record')
    release()
    expect(await first).toEqual({ kind: 'busy', run_id: 'r' })
    expect(await record_of(base, 'r')).toBeNull()
  })

  it('drives the record that won when another start creates the run first', async () => {
    const base = memory_store()
    let raced = false
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          // Another start, outside the lease, creates the record just ahead.
          set_if: async (key, value, expected) => {
            if (!raced && expected === null) {
              raced = true
              await scope.set_if(key, { ...(value as object), input: 'theirs' }, null)
            }
            return scope.set_if(key, value, expected)
          },
        }
      },
    }
    const flow = step('echo', (s: string) => `${s}!`)
    expect(await durable({ store }).start('r', flow, 'ours', QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'theirs!',
    })
    expect(await record_of(base, 'r')).toMatchObject({ input: 'theirs' })
  })

  it('gives up a drive whose run was deleted under it', async () => {
    const store = memory_store()
    const in_step = Promise.withResolvers<void>()
    const deleted = Promise.withResolvers<void>()
    const flow = step('slow', async () => {
      in_step.resolve()
      await deleted.promise
      return 'orphaned'
    })
    const first = durable({ store }).start('r', flow, null, QUIET)
    await in_step.promise
    await store.scope('r').delete('record')
    deleted.resolve()
    expect(await first).toEqual({ kind: 'busy', run_id: 'r' })
    expect(await record_of(store, 'r')).toBeNull()
  })

  it("won't save a drive's result once another drive holds the run", async () => {
    const base = memory_store()
    let claims = 0
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          claim: async (key, owner, ttl_ms) => {
            claims += 1
            return claims === 1 ? scope.claim(key, owner, ttl_ms) : false
          },
        }
      },
    }
    expect(await durable({ store }).start('r', step('one', () => 1), null, QUIET)).toEqual({
      kind: 'busy',
      run_id: 'r',
    })
    expect(await record_of(base, 'r')).toMatchObject({ status: 'running' })
  })

  it('lets the next drive take the run as soon as one ends, even with a renewal in flight', async () => {
    const base = memory_store()
    let calls = 0
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          // Renewals (every claim after the first) are slow to answer.
          claim: async (key, owner, ttl_ms) => {
            calls += 1
            if (calls > 1) await sleep(60)
            return scope.claim(key, owner, ttl_ms)
          },
        }
      },
    }
    const flow = step('brief', async () => {
      await sleep(25)
      return 'finished'
    })
    await durable({ store, lease_ms: 30 }).start('r', flow, null, QUIET)
    await sleep(100)
    expect(await base.scope('r').claim('lease', 'next', 60_000)).toBe(true)
  })

  it('stops renewing the lease once the drive lets the run go', async () => {
    const base = memory_store()
    let settled = false
    let late_claims = 0
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          claim: async (key, owner, ttl_ms) => {
            if (settled) late_claims += 1
            return scope.claim(key, owner, ttl_ms)
          },
        }
      },
    }
    // The drive outlasts a few renewals, so the timer is running when it ends.
    const flow = step('brief', async () => {
      await sleep(25)
      return 'finished'
    })
    await durable({ store, lease_ms: 30 }).start('r', flow, null, QUIET)
    settled = true
    await sleep(50)
    expect(late_claims).toBe(0)
  })
})

describe('durable: deadlines', () => {
  it('stamps when a gate deadline passes, counted from the moment the run stopped there', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    const runs = durable({ store: memory_store() })
    const flow = sequence([gate('ci', { deadline_ms: 3_600_000 })])
    const outcome = await runs.start('r', flow, 'pr', QUIET)
    expect(outcome).toStrictEqual({
      kind: 'suspended',
      run_id: 'r',
      id: 'ci',
      payload: { input: 'pr' },
      deadline_at: 4_600_000,
    })
    vi.setSystemTime(2_000_000)
    expect(await runs.get('r')).toMatchObject({ deadline_at: 4_600_000 })
    expect(await runs.start('r', flow, 'pr', QUIET)).toMatchObject({ deadline_at: 4_600_000 })
  })

  it('resumes a gate with whatever its timer sends when the deadline passes', async () => {
    const runs = durable({ store: memory_store() })
    const flow = sequence([gate('ci', { deadline_ms: 50 })])
    await runs.start('r', flow, 'pr', QUIET)
    expect(await runs.resume('r', flow, { ci: { ok: false } }, QUIET)).toMatchObject({
      kind: 'done',
      output: 'pr-ci',
    })
  })
})

describe('durable: the flow a run started on', () => {
  const two_steps = (draft = 'draft') =>
    sequence([step(draft, (s: string) => `${s}!`), gate('approve')])

  it('throws flow_changed_error when the flow changed shape while the run waited', async () => {
    const runs = durable({ store: memory_store() })
    await runs.start('r', two_steps(), 'in', QUIET)
    const err: unknown = await runs
      .resume('r', two_steps('rewrite'), { approve: { ok: true } }, QUIET)
      .catch((caught: unknown) => caught)
    expect(err).toBeInstanceOf(flow_changed_error)
    const changed = err as flow_changed_error
    expect(changed.run_id).toBe('r')
    expect(changed.started_on).toMatch(/^[0-9a-f]{16}$/)
    expect(changed.continued_on).toMatch(/^[0-9a-f]{16}$/)
    expect(changed.started_on).not.toBe(changed.continued_on)
    expect(changed.message).toBe(
      `durable run r started on a flow of another shape (${changed.started_on}, now ${changed.continued_on}): finish it on the flow it started with, delete it, or drive it with on_flow_change: 'replay'`,
    )
    // The run is untouched: the event still waits, and the old flow resumes it.
    expect(await runs.resume('r', two_steps(), {}, QUIET)).toMatchObject({ kind: 'done', output: 'in!+approve' })
  })

  it('ignores names, descriptions, prompts, and generated ids', async () => {
    const runs = durable({ store: memory_store() })
    await runs.start('r', sequence([step('draft', (s: string) => s), gate('approve')]), 'in', QUIET)
    const reworded = sequence(
      [
        step('draft', (s: string) => `${s} reworded`, { name: 'Draft it', description: 'a new note' }),
        gate('approve'),
      ],
      { name: 'renamed', description: 'described' },
    )
    expect(await runs.resume('r', reworded, { approve: { ok: true } }, QUIET)).toMatchObject({
      kind: 'done',
    })
  })

  it('replays a changed flow when told to, recording the change once', async () => {
    const store = memory_store()
    await durable({ store }).start('r', sequence([gate('first'), gate('second')]), 'in', QUIET)
    const replaying = durable({ store, on_flow_change: 'replay' })
    const { logger, events } = recording_logger()
    const changed = sequence([step('added', (s: string) => `${s}*`), gate('first'), gate('second')])
    expect(
      await replaying.resume('r', changed, { first: { ok: true } }, { ...QUIET, trajectory: logger }),
    ).toMatchObject({ kind: 'suspended', id: 'second' })
    const flow_changes = events.filter((e: TrajectoryEvent) => e.kind === 'flow_changed')
    expect(flow_changes).toHaveLength(1)
    expect(flow_changes[0]).toMatchObject({ run_id: 'r', ts: expect.any(Number) })
    expect(flow_changes[0]?.['started_on']).toMatch(/^[0-9a-f]{16}$/)
    expect(flow_changes[0]?.['continued_on']).toMatch(/^[0-9a-f]{16}$/)
    expect(flow_changes[0]?.['started_on']).not.toBe(flow_changes[0]?.['continued_on'])
    expect(await durable({ store }).resume('r', changed, { second: { ok: true } }, QUIET)).toMatchObject({
      kind: 'done',
      output: 'in*+first+second',
    })
  })

  it('replays a changed flow quietly when the caller passes no trajectory', async () => {
    const store = memory_store()
    await durable({ store }).start('r', two_steps(), 'in', QUIET)
    const replaying = durable({ store, on_flow_change: 'replay' })
    expect(await replaying.resume('r', two_steps('rewrite'), { approve: { ok: true } }, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'in!+approve',
    })
  })

  it('reports a waiting run on a changed flow without complaint when nothing would run', async () => {
    const runs = durable({ store: memory_store() })
    await runs.start('r', two_steps(), 'in', QUIET)
    expect(await runs.start('r', two_steps('rewrite'), 'in', QUIET)).toMatchObject({
      kind: 'suspended',
      id: 'approve',
    })
  })
})

describe('durable: failures', () => {
  it('drops a resume the gate refuses and keeps waiting, deadline and all', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const runs = durable({ store: memory_store() })
    const flow = sequence([gate('approve', { deadline_ms: 500 })])
    await runs.start('r', flow, 'in', QUIET)
    await expect(runs.resume('r', flow, { approve: { ok: 'maybe' } }, QUIET)).rejects.toBeInstanceOf(
      resume_validation_error,
    )
    expect(await runs.get('r')).toStrictEqual({
      kind: 'suspended',
      run_id: 'r',
      id: 'approve',
      payload: { input: 'in' },
      deadline_at: 1_500,
    })
    expect(await runs.resume('r', flow, { approve: { ok: true } }, QUIET)).toMatchObject({
      kind: 'done',
      output: 'in+approve',
    })
  })

  it('keeps the gates already passed when it drops a refused resume', async () => {
    const runs = durable({ store: memory_store() })
    const flow = sequence([gate('first'), gate('second')])
    await runs.start('r', flow, 'go', QUIET)
    await runs.resume('r', flow, { first: { ok: true } }, QUIET)
    await expect(runs.resume('r', flow, { second: { ok: 'maybe' } }, QUIET)).rejects.toBeInstanceOf(
      resume_validation_error,
    )
    expect(await runs.resume('r', flow, { second: { ok: true } }, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'go+first+second',
    })
  })

  it('marks a run failed when a step throws a validation error of its own before any gate', async () => {
    const runs = durable({ store: memory_store() })
    const flow = step('strict', () => {
      throw new resume_validation_error('the step checked its own input', [])
    })
    await expect(runs.start('r', flow, null, QUIET)).rejects.toBeInstanceOf(resume_validation_error)
    expect(await runs.get('r')).toEqual({
      kind: 'failed',
      run_id: 'r',
      error: 'the step checked its own input',
    })
  })

  it('marks a run failed when a step throws, and redrives it on the next event', async () => {
    const runs = durable({ store: memory_store() })
    let broken = true
    const flow = sequence([
      gate('approve'),
      step('ship', (s: string) => {
        if (broken) throw new Error('registry down')
        return `${s} shipped`
      }),
    ])
    await runs.start('r', flow, 'in', QUIET)
    await expect(runs.resume('r', flow, { approve: { ok: true } }, QUIET)).rejects.toThrow('registry down')
    expect(await runs.get('r')).toEqual({ kind: 'failed', run_id: 'r', error: 'registry down' })
    broken = false
    expect(await runs.resume('r', flow, {}, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'in+approve shipped',
    })
  })

  it("surfaces the step's error when the store can't save the failure", async () => {
    const base = memory_store()
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          set_if: async (key, value, expected) => {
            if (typeof value === 'object' && value !== null && 'status' in value && value.status === 'failed') {
              throw new Error('store is down')
            }
            return scope.set_if(key, value, expected)
          },
        }
      },
    }
    const flow = step('ship', () => {
      throw new Error('registry down')
    })
    await expect(durable({ store }).start('r', flow, null, QUIET)).rejects.toThrow('registry down')
    expect(await record_of(base, 'r')).toMatchObject({ status: 'running' })
  })

  it('records a thrown value that is not an Error by its string form', async () => {
    const runs = durable({ store: memory_store() })
    const flow = step('odd', () => {
      // A step can throw anything; the record keeps its string form.
      // oxlint-disable-next-line no-throw-literal
      throw 'just a string'
    })
    await expect(runs.start('r', flow, null, QUIET)).rejects.toBe('just a string')
    expect(await runs.get('r')).toEqual({ kind: 'failed', run_id: 'r', error: 'just a string' })
  })

  it('marks a run failed when a gate it passed long ago now refuses its data', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const loose = sequence([gate('first'), gate('second')])
    await runs.start('r', loose, 'in', QUIET)
    await runs.resume('r', loose, { first: { ok: true } }, QUIET)
    const strict_first = suspend({
      id: 'first',
      on: () => {},
      resume_schema: z.object({ ok: z.literal(false) }),
      combine: (input: string) => input,
    })
    const strict = sequence([strict_first, gate('second')])
    await expect(runs.resume('r', strict, { second: { ok: true } }, QUIET)).rejects.toBeInstanceOf(
      resume_validation_error,
    )
    expect(await runs.get('r')).toMatchObject({ kind: 'failed' })
  })

  it('redrives a run whose last drive died partway', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('approve')])
    await runs.start('r', flow, 'in', QUIET)
    const record = (await record_of(store, 'r')) as Record<string, unknown>
    await store.scope('r').set('record', {
      ...record,
      status: 'running',
      resume_data: { approve: { ok: true } },
    })
    expect(await runs.get('r')).toEqual({ kind: 'running', run_id: 'r' })
    expect(await runs.start('r', flow, 'in', QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'in+approve',
    })
  })
})

describe('durable: get and delete', () => {
  it('knows nothing of a run that never started', async () => {
    expect(await durable({ store: memory_store() }).get('ghost')).toBeUndefined()
  })

  it('deletes everything a run keeps when no drive holds it', async () => {
    const store = memory_store()
    const runs = durable({ store })
    await runs.start('r', sequence([gate('approve')]), 'in', QUIET)
    await runs.start('other', sequence([gate('approve')]), 'in', QUIET)
    expect(await runs.delete('r')).toBe(true)
    expect(await runs.get('r')).toBeUndefined()
    expect(Object.keys(store.dump())).toEqual([JSON.stringify(['other'])])
  })

  it('refuses to delete a run while a drive holds it', async () => {
    const store = memory_store()
    const runs = durable({ store })
    await runs.start('r', sequence([gate('approve')]), 'in', QUIET)
    await store.scope('r').claim('lease', 'busy drive', 60_000)
    expect(await runs.delete('r')).toBe(false)
    expect(await runs.get('r')).toMatchObject({ kind: 'suspended' })
  })
})

describe('durable: a run from before the inbox moved into the record', () => {
  // The old inbox scope of `run_id`, where a driver that wrote `format: 1`
  // kept the events waiting on gates.
  const old_inbox = (store: MemoryStore, run_id: string) => store.scope(run_id).scope('inbox')
  const OLD_INBOX = JSON.stringify(['r', 'inbox'])

  it('takes up the datum that waited in the old inbox scope, and saves the record as format 2', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('approve')])
    await runs.start('r', flow, 'in', QUIET)
    await as_format_1(store, 'r')
    await old_inbox(store, 'r').set('approve', { data: { ok: true } })
    expect(await runs.get('r')).toMatchObject({ kind: 'suspended', id: 'approve' })
    expect(await runs.resume('r', flow, {}, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'in+approve',
    })
    // One write to migrate, one to take the datum up, one for the end.
    expect(await record_of(store, 'r')).toMatchObject({ format: 2, revision: 4, inbox: {} })
    expect(Object.keys(store.dump())).not.toContain(OLD_INBOX)
  })

  it('keeps a datum that waited there for a gate the run has yet to reach', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('first'), sequence([gate('second')])])
    await runs.start('r', flow, 'go', QUIET)
    await as_format_1(store, 'r')
    await old_inbox(store, 'r').set('second', { data: { ok: false } })
    expect(await runs.start('r', flow, 'go', QUIET)).toMatchObject({ kind: 'suspended', id: 'first' })
    expect(await record_of(store, 'r')).toMatchObject({
      format: 2,
      inbox: { second: { data: { ok: false } } },
    })
    expect(Object.keys(store.dump())).not.toContain(OLD_INBOX)
    expect(await runs.resume('r', flow, { first: { ok: true } }, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'go+first-second',
    })
  })

  it('gives the gate the datum that waited there over one delivered since', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('approve')])
    await runs.start('r', flow, 'in', QUIET)
    await as_format_1(store, 'r')
    await old_inbox(store, 'r').set('approve', { data: { ok: true } })
    await store.scope('r').claim('lease', 'someone else', 60_000)
    expect(await runs.resume('r', flow, { approve: { ok: false } }, QUIET)).toEqual({
      kind: 'busy',
      run_id: 'r',
    })
    // A delivery leaves the format alone, so the drive still migrates.
    expect(await record_of(store, 'r')).toMatchObject({
      format: 1,
      inbox: { approve: { data: { ok: false } } },
    })
    await store.scope('r').release('lease', 'someone else')
    expect(await runs.resume('r', flow, {}, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'in+approve',
    })
  })

  it('drops what waited there for a gate the run already passed, and anything that is no datum', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('first'), gate('second'), gate('third')])
    await runs.start('r', flow, 'go', QUIET)
    await runs.resume('r', flow, { first: { ok: true } }, QUIET)
    await as_format_1(store, 'r')
    await old_inbox(store, 'r').set('first', { data: { ok: false } })
    await old_inbox(store, 'r').set('third', 'not an entry')
    await old_inbox(store, 'r').set('never a gate', { data: { ok: true } })
    expect(await runs.resume('r', flow, {}, QUIET)).toMatchObject({
      kind: 'suspended',
      id: 'second',
      payload: { input: 'go+first' },
    })
    const record = (await record_of(store, 'r')) as { inbox: unknown }
    expect(record).toMatchObject({ format: 2, resume_data: { first: { ok: true } } })
    expect(record.inbox).toStrictEqual({})
    expect(Object.keys(store.dump())).not.toContain(OLD_INBOX)
  })

  it('migrates a record with nothing waiting, and only once', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('approve')])
    await runs.start('r', flow, 'in', QUIET)
    await as_format_1(store, 'r')
    await runs.resume('r', flow, {}, QUIET)
    expect(await record_of(store, 'r')).toMatchObject({ format: 2, revision: 2, inbox: {} })
    // A datum left in the old scope after the migration is never read.
    await old_inbox(store, 'r').set('approve', { data: { ok: true } })
    expect(await runs.resume('r', flow, {}, QUIET)).toMatchObject({ kind: 'suspended', id: 'approve' })
    expect(await record_of(store, 'r')).toMatchObject({ format: 2, revision: 2 })
  })
})

describe('durable: an inbox it cannot read', () => {
  it.each([
    ['is missing', undefined],
    ['is not an object', 'approve'],
    ['holds an entry with no datum', { approve: { ok: true } }],
    ['holds an entry that is not an object', { approve: 'yes' }],
  ])('waits at the gate when the inbox %s', async (_, inbox) => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('approve')])
    await runs.start('r', flow, 'in', QUIET)
    const record = (await record_of(store, 'r')) as Record<string, unknown>
    await store.scope('r').set('record', { ...record, inbox })
    expect(await runs.resume('r', flow, {}, QUIET)).toMatchObject({ kind: 'suspended', id: 'approve' })
    // The gate is still open to the next datum, which the bad entry didn't take.
    expect(await runs.resume('r', flow, { approve: { ok: true } }, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'in+approve',
    })
    expect(await record_of(store, 'r')).toMatchObject({ inbox: {} })
  })

  it('keeps the entries it can read beside one it cannot', async () => {
    const store = memory_store()
    const runs = durable({ store })
    const flow = sequence([gate('first'), gate('second')])
    await runs.start('r', flow, 'go', QUIET)
    const record = (await record_of(store, 'r')) as Record<string, unknown>
    await store.scope('r').set('record', {
      ...record,
      inbox: { first: 'torn', second: { data: { ok: true } } },
    })
    expect(await runs.resume('r', flow, { first: { ok: false } }, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'go-first+second',
    })
  })
})

describe('durable: records it cannot read', () => {
  const valid = {
    format: 1,
    revision: 3,
    input: 'in',
    flow: 'f',
    resume_data: {},
    output: null,
    error: '',
    status: 'suspended',
    suspended: { id: 'approve', payload: { input: 'in' }, deadline_at: null },
  }

  it('reads a well-formed record', async () => {
    const store = memory_store()
    await store.scope('r').set('record', valid)
    expect(await durable({ store }).get('r')).toStrictEqual({
      kind: 'suspended',
      run_id: 'r',
      id: 'approve',
      payload: { input: 'in' },
    })
  })

  it.each([
    ['a non-object', 'record'],
    ['an array', [valid]],
    ['a format from a later driver', { ...valid, format: 3 }],
    ['no format', { ...valid, format: undefined }],
    ['no revision', { ...valid, revision: 'three' }],
    ['no flow fingerprint', { ...valid, flow: 7 }],
    ['resume data that is not an object', { ...valid, resume_data: [] }],
    ['resume data that is null', { ...valid, resume_data: null }],
    ['an unknown status', { ...valid, status: 'paused' }],
    ['a suspension with no gate id', { ...valid, suspended: { payload: null } }],
    ['a suspension that is not an object', { ...valid, suspended: 'approve' }],
  ])('treats %s as no record', async (_, record) => {
    const store = memory_store()
    await store.scope('r').set('record', record)
    expect(await durable({ store }).get('r')).toBeUndefined()
  })

  it('reads a missing error as empty and a stray deadline as none', async () => {
    const store = memory_store()
    await store.scope('r').set('record', { ...valid, status: 'failed', error: 42, suspended: null })
    await store.scope('s').set('record', { ...valid, suspended: { id: 'approve', deadline_at: 'soon' } })
    const runs = durable({ store })
    expect(await runs.get('r')).toEqual({ kind: 'failed', run_id: 'r', error: '' })
    expect(await runs.get('s')).toStrictEqual({ kind: 'suspended', run_id: 's', id: 'approve', payload: undefined })
  })

  it('starts a run over from its input when its record is unreadable', async () => {
    const store = memory_store()
    await store.scope('r').set('record', { format: 1, status: 'garbled' })
    const flow: Step<string, string> = step('echo', (s: string) => `${s}!`)
    expect(await durable({ store }).start('r', flow, 'fresh', QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'fresh!',
    })
  })
})
