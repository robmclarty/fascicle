import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedTrajectoryEvent } from '#core'
import { start_tail, type Tail } from '../tail.js'

/**
 * Deterministic tail tests. The tailer's hard paths are async and were
 * previously reached with fixed `wait(50)` sleeps that neither pinned the
 * ordering nor killed the io-error/coalescing mutants. Two things replace them:
 *
 *   - The public `drain()` forces a read synchronously, so every append is
 *     observed by awaiting `drain()` rather than sleeping for the watcher.
 *   - Two passthrough module mocks (`node:fs` for `watch`, `node:fs/promises`
 *     for `stat`/`open`) that delegate to the real implementation until a test
 *     arms a one-shot on the shared `gate`. This lets a test park a read
 *     mid-flight (to prove burst coalescing) or fail a single syscall (to reach
 *     an `on_io_error` branch) with no timing at all. Disarmed, both mocks are
 *     transparent, so the real-file behavioural tests run against real fs.
 *
 * Equivalent-mutant ledger (survivors left after this suite, all behaviourally
 * unobservable, so classified here rather than chased):
 *   - `let pending = false` init (schedule overwrites it before any read reads
 *     it, so `true` is equivalent).
 *   - `if (st.size === offset) return`: the `false` variant still reads zero
 *     bytes and emits nothing, so it is a no-op.
 *   - `length = st.size - offset` -> `+`: `fh.read` is bounded by the file size,
 *     so an over-large length reads the same bytes.
 *   - the `finally { await fh.close() }` block: dropping the close leaks a
 *     descriptor with no behavioural signature under test.
 *   - `fs.watch` options `{ persistent: true }` -> `{}` / `{ persistent: false }`:
 *     the watcher still delivers appends in-process either way.
 *   - `stop()`'s `if (watcher)` false-branch and its emptied body: with the
 *     watcher left open, `closed` still gates every later read, so no event
 *     escapes. The two-close crash is what the idempotence test pins.
 */

type Deferred<T = void> = {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
}

const emit_line = (text: string): string => JSON.stringify({ kind: 'emit', text }) + '\n'

const deferred = <T = void>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type StatArm = { readonly entered: Deferred; readonly release: Deferred }

const gate = vi.hoisted(() => ({
  // One-shot park for the next stat call: resolves `entered` when the read
  // reaches its stat and blocks on `release` until the test lets it proceed.
  stat_arm: null as StatArm | null,
  // Persistent one-file failures; a test flips one on, afterEach clears it.
  stat_fails: false,
  open_fails: false,
  watch_fails: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      if (gate.watch_fails) throw new Error('mock watch failure')
      return actual.watch(...args)
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (gate.stat_fails) throw new Error('mock stat failure')
      const arm = gate.stat_arm
      if (arm) {
        gate.stat_arm = null
        arm.entered.resolve()
        await arm.release.promise
      }
      return actual.stat(...args)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (gate.open_fails) throw new Error('mock open failure')
      return actual.open(...args)
    },
  }
})

let work_dir = ''
const tails: Tail[] = []

const spawn = (config: Parameters<typeof start_tail>[0]): Tail => {
  const tail = start_tail(config)
  tails.push(tail)
  return tail
}

beforeEach(() => {
  work_dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-tail-'))
  gate.stat_arm = null
  gate.stat_fails = false
  gate.open_fails = false
  gate.watch_fails = false
})

afterEach(() => {
  for (const tail of tails.splice(0)) tail.stop()
  rmSync(work_dir, { recursive: true, force: true })
})

describe('start_tail', () => {
  it('parses initial lines from an existing file', async () => {
    const path = join(work_dir, 'a.jsonl')
    writeFileSync(
      path,
      [
        JSON.stringify({ kind: 'span_start', span_id: 's1', name: 'step' }),
        JSON.stringify({ kind: 'span_end', span_id: 's1' }),
      ].join('\n') + '\n',
    )
    const events: ParsedTrajectoryEvent[] = []
    const tail = spawn({ path, on_event: (e) => events.push(e) })
    await tail.drain()
    expect(events).toHaveLength(2)
    expect(events[0]?.kind).toBe('span_start')
    expect(events[1]?.kind).toBe('span_end')
  })

  it('picks up appended lines when the watcher fires', async () => {
    const path = join(work_dir, 'b.jsonl')
    writeFileSync(path, '')
    const events: ParsedTrajectoryEvent[] = []
    let notify: (() => void) | null = null
    const tail = spawn({
      path,
      on_event: (e) => {
        events.push(e)
        notify?.()
      },
    })
    await tail.drain()

    // No drain() after this append: the event can only arrive if the watcher
    // callback runs, so an emptied watch call or dead callback hangs here.
    const arrived = deferred()
    notify = () => arrived.resolve()
    appendFileSync(path, JSON.stringify({ kind: 'emit', span_id: 's1', text: 'hi' }) + '\n')
    await arrived.promise
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('emit')
  })

  it('buffers a partial last line until the newline arrives', async () => {
    const path = join(work_dir, 'c.jsonl')
    writeFileSync(path, '{"kind":"emit","text":"hel')
    const events: ParsedTrajectoryEvent[] = []
    const tail = spawn({ path, on_event: (e) => events.push(e) })
    await tail.drain()
    expect(events).toHaveLength(0)

    appendFileSync(path, 'lo"}\n')
    await tail.drain()
    expect(events).toHaveLength(1)
  })

  it('resets and re-streams from offset 0 when the file is truncated', async () => {
    const path = join(work_dir, 'd.jsonl')
    writeFileSync(
      path,
      JSON.stringify({ kind: 'emit', text: 'one' }) + '\n' + JSON.stringify({ kind: 'emit', text: 'two' }) + '\n',
    )
    const events: ParsedTrajectoryEvent[] = []
    const tail = spawn({ path, on_event: (e) => events.push(e) })
    await tail.drain()
    expect(events).toHaveLength(2)

    truncateSync(path, 0)
    appendFileSync(path, JSON.stringify({ kind: 'emit', text: 'fresh' }) + '\n')
    await tail.drain()

    const fresh = events.filter((e) => e.kind === 'emit')
    expect(fresh.some((e) => (e as Record<string, unknown>)['text'] === 'fresh')).toBe(true)
  })

  it('skips blank lines without reporting a parse error', async () => {
    const path = join(work_dir, 'blank.jsonl')
    writeFileSync(
      path,
      JSON.stringify({ kind: 'emit', text: 'one' }) + '\n\n' + JSON.stringify({ kind: 'emit', text: 'two' }) + '\n',
    )
    const events: ParsedTrajectoryEvent[] = []
    const errors: unknown[] = []
    const tail = spawn({
      path,
      on_event: (e) => events.push(e),
      on_parse_error: (err) => errors.push(err),
    })
    await tail.drain()
    expect(events).toHaveLength(2)
    expect(errors).toHaveLength(0)
  })

  describe('malformed-line taxonomy', () => {
    it('reports a JSON syntax error as a SyntaxError and keeps going', async () => {
      const path = join(work_dir, 'e.jsonl')
      writeFileSync(path, 'not json\n' + JSON.stringify({ kind: 'emit', text: 'ok' }) + '\n')
      const events: ParsedTrajectoryEvent[] = []
      const errors: unknown[] = []
      const tail = spawn({
        path,
        on_event: (e) => events.push(e),
        on_parse_error: (err) => errors.push(err),
      })
      await tail.drain()
      expect(events).toHaveLength(1)
      expect(errors).toHaveLength(1)
      // Distinguishes the JSON.parse catch from the schema branch: only the
      // former surfaces a SyntaxError. An emptied catch would fall through to
      // parse_trajectory_event(undefined) and report a plain Error instead.
      expect(errors[0]).toBeInstanceOf(SyntaxError)
    })

    it('does not throw on malformed JSON when no on_parse_error is set', async () => {
      const path = join(work_dir, 'e2.jsonl')
      writeFileSync(path, '')
      const events: ParsedTrajectoryEvent[] = []
      const tail = spawn({ path, on_event: (e) => events.push(e) })
      await tail.drain()

      appendFileSync(path, 'not json\n')
      await expect(tail.drain()).resolves.toBeUndefined()
      expect(events).toHaveLength(0)
    })

    it('reports a schema failure (valid JSON, wrong shape) via on_parse_error', async () => {
      const path = join(work_dir, 'schema.jsonl')
      writeFileSync(path, JSON.stringify({ nope: true }) + '\n' + JSON.stringify({ kind: 'emit', text: 'ok' }) + '\n')
      const events: ParsedTrajectoryEvent[] = []
      const errors: unknown[] = []
      const tail = spawn({
        path,
        on_event: (e) => events.push(e),
        on_parse_error: (err) => errors.push(err),
      })
      await tail.drain()
      expect(events).toHaveLength(1)
      expect(events[0]?.kind).toBe('emit')
      expect(errors).toHaveLength(1)
      expect(errors[0]).not.toBeInstanceOf(SyntaxError)
    })

    it('does not throw on a schema failure when no on_parse_error is set', async () => {
      const path = join(work_dir, 'schema2.jsonl')
      writeFileSync(path, '')
      const events: ParsedTrajectoryEvent[] = []
      const tail = spawn({ path, on_event: (e) => events.push(e) })
      await tail.drain()

      appendFileSync(path, JSON.stringify({ nope: true }) + '\n')
      await expect(tail.drain()).resolves.toBeUndefined()
      expect(events).toHaveLength(0)
    })
  })

  describe('on_io_error', () => {
    it('surfaces a stat failure via on_io_error and reads nothing', async () => {
      const path = join(work_dir, 'stat.jsonl')
      writeFileSync(path, JSON.stringify({ kind: 'emit', text: 'x' }) + '\n')
      const events: ParsedTrajectoryEvent[] = []
      const errors: unknown[] = []
      gate.stat_fails = true
      const tail = spawn({
        path,
        on_event: (e) => events.push(e),
        on_io_error: (err) => errors.push(err),
      })
      await tail.drain()
      expect(errors.length).toBeGreaterThanOrEqual(1)
      expect(events).toHaveLength(0)
    })

    it('does not throw when stat fails and no on_io_error is set', async () => {
      const path = join(work_dir, 'stat2.jsonl')
      writeFileSync(path, '')
      const events: ParsedTrajectoryEvent[] = []
      const tail = spawn({ path, on_event: (e) => events.push(e) })
      await tail.drain()

      gate.stat_fails = true
      appendFileSync(path, JSON.stringify({ kind: 'emit', text: 'x' }) + '\n')
      await expect(tail.drain()).resolves.toBeUndefined()
    })

    it('surfaces an open failure via on_io_error and reads nothing', async () => {
      const path = join(work_dir, 'open.jsonl')
      writeFileSync(path, '')
      const events: ParsedTrajectoryEvent[] = []
      const errors: unknown[] = []
      const tail = spawn({
        path,
        on_event: (e) => events.push(e),
        on_io_error: (err) => errors.push(err),
      })
      await tail.drain()

      gate.open_fails = true
      appendFileSync(path, JSON.stringify({ kind: 'emit', text: 'x' }) + '\n')
      await expect(tail.drain()).resolves.toBeUndefined()
      expect(errors.length).toBeGreaterThanOrEqual(1)
      expect(events).toHaveLength(0)
    })

    it('does not throw when open fails and no on_io_error is set', async () => {
      const path = join(work_dir, 'open2.jsonl')
      writeFileSync(path, '')
      const events: ParsedTrajectoryEvent[] = []
      const tail = spawn({ path, on_event: (e) => events.push(e) })
      await tail.drain()

      gate.open_fails = true
      appendFileSync(path, JSON.stringify({ kind: 'emit', text: 'x' }) + '\n')
      await expect(tail.drain()).resolves.toBeUndefined()
    })

    it('surfaces a watch failure via on_io_error', async () => {
      const path = join(work_dir, 'watch.jsonl')
      writeFileSync(path, '')
      const errors: unknown[] = []
      gate.watch_fails = true
      const tail = spawn({
        path,
        on_event: () => {},
        on_io_error: (err) => errors.push(err),
      })
      await tail.drain()
      // stat still succeeds here, so this on_io_error can only come from the
      // watch catch: an emptied catch or dead guard leaves errors empty.
      expect(errors.length).toBeGreaterThanOrEqual(1)
    })

    it('does not throw constructing a tail when watch fails and no on_io_error is set', () => {
      const path = join(work_dir, 'watch2.jsonl')
      writeFileSync(path, '')
      gate.watch_fails = true
      expect(() => spawn({ path, on_event: () => {} })).not.toThrow()
    })
  })

  it('coalesces a schedule that arrives mid-read into one extra pass', async () => {
    const path = join(work_dir, 'coalesce.jsonl')
    writeFileSync(path, emit_line('one'))
    const events: ParsedTrajectoryEvent[] = []
    let two_seen: (() => void) | null = null
    const tail = spawn({
      path,
      on_event: (e) => {
        events.push(e)
        if ((e as Record<string, unknown>)['text'] === 'two') two_seen?.()
      },
    })
    await tail.drain()
    expect(events).toHaveLength(1)

    // Park read pass A at its stat so we can drive a burst deterministically.
    const arm_a: StatArm = { entered: deferred(), release: deferred() }
    gate.stat_arm = arm_a
    appendFileSync(path, emit_line('two'))
    const drain_a = tail.drain() // starts pass A (busy = true), parks in stat
    await arm_a.entered.promise

    // A second schedule lands while busy: this is the burst. It must set
    // `pending` so the read loop takes one more pass after A finishes.
    const drain_b = tail.drain()

    // Arm pass B's stat before releasing A, so B (if it runs) parks too.
    const arm_b: StatArm = { entered: deferred(), release: deferred() }
    gate.stat_arm = arm_b

    const two_emitted = deferred()
    two_seen = () => two_emitted.resolve()
    arm_a.release.resolve() // A reads only 'two' (three not written yet)
    await two_emitted.promise

    // 'three' arrives after A has read: only the coalesced extra pass B can see
    // it. Without `pending`, B never runs and arm_b.entered never resolves.
    appendFileSync(path, emit_line('three'))
    await arm_b.entered.promise
    arm_b.release.resolve()
    await Promise.all([drain_a, drain_b])

    const texts = events.map((e) => (e as Record<string, unknown>)['text'])
    expect(texts).toEqual(['one', 'two', 'three'])
  })

  describe('stop', () => {
    it('does not read newly appended lines after stop', async () => {
      const path = join(work_dir, 'stop.jsonl')
      writeFileSync(path, '')
      const events: ParsedTrajectoryEvent[] = []
      const tail = spawn({ path, on_event: (e) => events.push(e) })
      await tail.drain()

      tail.stop()
      appendFileSync(path, JSON.stringify({ kind: 'emit', text: 'after' }) + '\n')
      // drain() schedules, but a stopped tail's closed guard must refuse it.
      await tail.drain()
      expect(events).toHaveLength(0)
    })

    it('is idempotent: calling stop twice does not throw', async () => {
      const path = join(work_dir, 'stop2.jsonl')
      writeFileSync(path, '')
      const tail = spawn({ path, on_event: () => {} })
      await tail.drain()
      tail.stop()
      // The second stop finds a nulled watcher; an always-true guard would call
      // close() on null and throw.
      expect(() => tail.stop()).not.toThrow()
    })
  })
})
