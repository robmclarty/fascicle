import {
  type FSWatcher,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedTrajectoryEvent } from '#core'
import { start_tail, type Tail } from '../tail.js'

/**
 * Deterministic tail tests. The tailer's hard paths are async, and a fixed
 * sleep neither pins their ordering nor kills the io-error/coalescing mutants,
 * so the suite never waits on the clock. Two things make that possible:
 *
 *   - The public `drain()` forces a read synchronously, so every append is
 *     observed by awaiting `drain()` rather than sleeping for the watcher.
 *   - Two passthrough module mocks (`node:fs` for `watch`, `node:fs/promises`
 *     for `stat`/`open` and the handle's `read`) that delegate to the real
 *     implementation until a test arms a one-shot on the shared `gate`. This
 *     lets a test park a read mid-flight (to prove burst coalescing) or fail a
 *     single syscall (to reach an `on_io_error` branch) with no timing at all.
 *     Disarmed, both mocks are transparent, so the real-file behavioural tests
 *     run against real fs.
 *   - The `watch` mock also records every watch the tail starts and whether
 *     it was closed, so a test can fire a listener by hand, as the platform
 *     would, and read which watches are open.
 *
 * Equivalent-mutant ledger (survivors left after this suite, all behaviourally
 * unobservable, so classified here rather than chased):
 *   - `let pending = false` init (schedule overwrites it before any read reads
 *     it, so `true` is equivalent).
 *   - `let buffer = ''` init: the first pass that finds the file adopts its
 *     inode and resets the buffer before it reads, so the initial value is
 *     never read.
 *   - `size === offset` in `read_more`'s early return: the `false` variant
 *     still reads zero bytes and emits nothing, so it is a no-op.
 *   - `length = size - offset` -> `+`: `fh.read` is bounded by the file size,
 *     so an over-large length reads the same bytes.
 *   - the `finally { await fh.close() }` block: dropping the close leaks a
 *     descriptor with no behavioural signature under test.
 *   - `fs.watch` options `{ persistent: true }` -> `{}` / `{ persistent: false }`:
 *     the watcher still delivers appends in-process either way.
 *
 * Phantom survivor (killed when applied by hand, reported as survived, and
 * left un-annotated so the killed mutants on its line still count): the
 * directory watch's name filter `filename === null || filename === name` ->
 * `false`. Applied by hand it times out three of the path-following tests,
 * the same whole-condition guard misreport that Stryker gives other async
 * tests in this repo.
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

type WatchRecord = { readonly target: string; readonly watcher: FSWatcher; closed: boolean }

const gate = vi.hoisted(() => ({
  // One-shot park for the next stat call: resolves `entered` when the read
  // reaches its stat and blocks on `release` until the test lets it proceed.
  stat_arm: null as StatArm | null,
  // Persistent one-file failures; a test flips one on, afterEach clears it.
  stat_fails: false,
  open_fails: false,
  read_fails: false,
  watch_fails: false,
  // Every stat reports this inode number, so a test can recreate a file under
  // the number the old one had, as a filesystem that reuses inodes does.
  fixed_ino: null as number | null,
  // A one-shot ENOENT from the next stat, as if the file weren't there yet,
  // so a test can stand in the gap between a stat and the watch after it.
  stat_missing_once: false,
  // Points each real watch at this empty directory instead of its target, so
  // only fire() reaches a listener. FSEvents can report a write made just
  // before a watch starts, which would stand in for the pass under test.
  quiet_dir: null as string | null,
  // Every watch the tail starts, in order, and whether it has been closed, so
  // a test can fire a listener by hand and see which watches are open.
  watches: [] as WatchRecord[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      if (gate.watch_fails) throw new Error('mock watch failure')
      const real_args = gate.quiet_dir === null ? args : [gate.quiet_dir, ...args.slice(1)]
      const watcher = Reflect.apply(actual.watch, undefined, real_args) as FSWatcher
      const record: WatchRecord = { target: String(args[0]), watcher, closed: false }
      const close = watcher.close.bind(watcher)
      Object.assign(watcher, {
        close: () => {
          record.closed = true
          close()
        },
      })
      gate.watches.push(record)
      return watcher
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (gate.stat_fails) throw new Error('mock stat failure')
      if (gate.stat_missing_once) {
        gate.stat_missing_once = false
        throw Object.assign(new Error('mock ENOENT'), { code: 'ENOENT' })
      }
      const arm = gate.stat_arm
      if (arm) {
        gate.stat_arm = null
        arm.entered.resolve()
        await arm.release.promise
      }
      const st = await actual.stat(...args)
      if (gate.fixed_ino !== null && st !== undefined) Object.assign(st, { ino: gate.fixed_ino })
      return st
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (gate.open_fails) throw new Error('mock open failure')
      const fh = await actual.open(...args)
      if (gate.read_fails) {
        // Shadows only `read`, so the real `close` still runs and the
        // descriptor is released the way it is on any other pass.
        Object.assign(fh, { read: async () => { throw new Error('mock read failure') } })
      }
      return fh
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
  gate.read_fails = false
  gate.watch_fails = false
  gate.fixed_ino = null
  gate.stat_missing_once = false
  gate.quiet_dir = null
  gate.watches = []
})

afterEach(() => {
  for (const tail of tails.splice(0)) tail.stop()
  rmSync(work_dir, { recursive: true, force: true })
})

/** The targets of the watches that are open now, oldest first. */
const open_watches = (): string[] =>
  gate.watches.filter((record) => !record.closed).map((record) => record.target)

/**
 * Fire the newest watch on `target` by hand, as the platform would. The
 * directory watch is fired this way because macOS serves it from an FSEvents
 * stream that starts asynchronously, so a write made just after the watch can
 * precede the stream and never be reported.
 */
const fire = (target: string, event: 'rename' | 'change', filename: string): void => {
  const record = gate.watches.findLast((candidate) => candidate.target === target)
  if (record === undefined) throw new Error(`no watch on ${target}`)
  record.watcher.emit('change', event, filename)
}

type Collector = {
  readonly texts: unknown[]
  readonly on_event: (event: ParsedTrajectoryEvent) => void
  readonly reach: (count: number) => Promise<void>
}

/**
 * Collects each event's text, and `reach(n)` resolves once n have arrived,
 * so a test can wait on the watcher alone, with no drain() and no sleep.
 */
const collector = (): Collector => {
  const texts: unknown[] = []
  const waits: Array<{ readonly count: number; readonly done: () => void }> = []
  return {
    texts,
    on_event: (event) => {
      texts.push((event as Record<string, unknown>)['text'])
      for (const wait of waits) if (texts.length >= wait.count) wait.done()
    },
    reach: (count) =>
      new Promise<void>((resolve) => {
        if (texts.length >= count) resolve()
        else waits.push({ count, done: resolve })
      }),
  }
}

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

    it('picks up where it left off after a stat that fails once, with no replay', async () => {
      const path = join(work_dir, 'stat-once.jsonl')
      writeFileSync(path, emit_line('one'))
      const seen = collector()
      const errors: unknown[] = []
      const tail = spawn({ path, on_event: seen.on_event, on_io_error: (err) => errors.push(err) })
      await tail.drain()

      // A failure that isn't a missing file keeps the inode and the offset,
      // and the failed pass reads nothing at all, so the stat's error is the
      // only one (a watcher pass may fail the same way, hence no exact count).
      gate.stat_fails = true
      await tail.drain()
      gate.stat_fails = false
      appendFileSync(path, emit_line('two'))
      await tail.drain()
      expect(seen.texts).toEqual(['one', 'two'])
      expect(errors.length).toBeGreaterThanOrEqual(1)
      for (const err of errors) expect(err).toEqual(new Error('mock stat failure'))
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

    it('surfaces a read failure via on_io_error and keeps the drain settled', async () => {
      const path = join(work_dir, 'read.jsonl')
      writeFileSync(path, '')
      const events: ParsedTrajectoryEvent[] = []
      const errors: unknown[] = []
      const tail = spawn({
        path,
        on_event: (e) => events.push(e),
        on_io_error: (err) => errors.push(err),
      })
      await tail.drain()

      gate.read_fails = true
      appendFileSync(path, JSON.stringify({ kind: 'emit', text: 'x' }) + '\n')
      // An unrouted read error rejects the drain promise, which a tail started
      // by the CLI never awaits, so it surfaces as an unhandled rejection.
      await expect(tail.drain()).resolves.toBeUndefined()
      expect(errors.length).toBeGreaterThanOrEqual(1)
      expect(errors[0]).toEqual(new Error('mock read failure'))
      expect(events).toHaveLength(0)

      // The failed pass consumed nothing, so the bytes are read once it clears.
      gate.read_fails = false
      await tail.drain()
      expect(events).toHaveLength(1)
    })

    it('does not throw when a read fails and no on_io_error is set', async () => {
      const path = join(work_dir, 'read2.jsonl')
      writeFileSync(path, '')
      const tail = spawn({ path, on_event: () => {} })
      await tail.drain()

      gate.read_fails = true
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

    it('does not throw when watch fails and no on_io_error is set', async () => {
      const path = join(work_dir, 'watch2.jsonl')
      writeFileSync(path, '')
      gate.watch_fails = true
      const tail = spawn({ path, on_event: () => {} })
      // The watch starts inside a read pass, so a throw would reject the drain.
      await expect(tail.drain()).resolves.toBeUndefined()
    })
  })

  describe('following the path', () => {
    it('reads a file created after start_tail from its first line, with no io error', async () => {
      const path = join(work_dir, 'late.jsonl')
      const seen = collector()
      const errors: unknown[] = []
      const tail = spawn({ path, on_event: seen.on_event, on_io_error: (err) => errors.push(err) })
      await tail.drain()
      expect(seen.texts).toEqual([])
      expect(open_watches()).toEqual([work_dir])

      // No drain() from here on: the directory watch announces the file, and
      // the file watch it hands over to carries the append.
      writeFileSync(path, emit_line('one') + emit_line('two'))
      fire(work_dir, 'rename', 'late.jsonl')
      await seen.reach(2)
      expect(open_watches()).toEqual([path])
      appendFileSync(path, emit_line('three'))
      await seen.reach(3)
      expect(seen.texts).toEqual(['one', 'two', 'three'])
      expect(errors).toEqual([])
      // An append is a change, not a rename, so the directory stays unwatched.
      expect(open_watches()).toEqual([path])
    })

    it('reads a file that appears between a stat and the directory watch', async () => {
      const path = join(work_dir, 'gap.jsonl')
      writeFileSync(path, emit_line('one'))
      // The first stat says the file isn't there, so the tail arms the
      // directory watch, which can't report a file that already exists. Only
      // the pass that arming schedules can find it. No drain().
      gate.quiet_dir = mkdtempSync(join(work_dir, 'quiet-'))
      gate.stat_missing_once = true
      const seen = collector()
      spawn({ path, on_event: seen.on_event })
      await seen.reach(1)
      expect(seen.texts).toEqual(['one'])
    })

    it('ignores an event for another file in the directory', async () => {
      const path = join(work_dir, 'mine.jsonl')
      const seen = collector()
      const tail = spawn({ path, on_event: seen.on_event })
      await tail.drain()

      // A pass that starts parks at its stat, so the arm shows whether the
      // event started one before the event for this file's name arrives.
      const arm: StatArm = { entered: deferred(), release: deferred() }
      gate.stat_arm = arm
      writeFileSync(path, emit_line('one'))
      fire(work_dir, 'rename', 'other.jsonl')
      expect(gate.stat_arm).toBe(arm)
      fire(work_dir, 'rename', 'mine.jsonl')
      await arm.entered.promise
      arm.release.resolve()
      await seen.reach(1)
      expect(seen.texts).toEqual(['one'])
    })

    it('follows a rename-and-recreate rotation onto the new file from its first line', async () => {
      const path = join(work_dir, 'rotate.jsonl')
      writeFileSync(path, emit_line('one'))
      const seen = collector()
      const errors: unknown[] = []
      const tail = spawn({
        path,
        on_event: seen.on_event,
        on_parse_error: (err) => errors.push(err),
        on_io_error: (err) => errors.push(err),
      })
      await tail.drain()
      expect(seen.texts).toEqual(['one'])
      expect(open_watches()).toEqual([path])

      // The file watch reports the rename, which puts a watch back on the
      // directory for whatever takes the name next.
      renameSync(path, `${path}.1`)
      fire(path, 'rename', 'rotate.jsonl')
      expect(open_watches()).toEqual([path, work_dir])

      // The new file is longer than the old offset, so only its inode says
      // it's a different file.
      writeFileSync(path, emit_line('two') + emit_line('three'))
      fire(work_dir, 'rename', 'rotate.jsonl')
      await seen.reach(3)
      expect(open_watches()).toEqual([path])
      appendFileSync(path, emit_line('four'))
      await seen.reach(4)
      expect(seen.texts).toEqual(['one', 'two', 'three', 'four'])
      expect(errors).toEqual([])
    })

    it('waits on the directory again each time the file moves away', async () => {
      const path = join(work_dir, 'again.jsonl')
      const seen = collector()
      const tail = spawn({ path, on_event: seen.on_event })
      await tail.drain()

      for (const [round, text] of ['one', 'two'].entries()) {
        writeFileSync(path, emit_line(text))
        fire(work_dir, 'rename', 'again.jsonl')
        await seen.reach(round + 1)
        renameSync(path, `${path}.${String(round)}`)
        fire(path, 'rename', 'again.jsonl')
      }
      expect(seen.texts).toEqual(['one', 'two'])
      expect(gate.watches.filter((record) => record.target === work_dir)).toHaveLength(3)
    })

    it('tries the directory watch once a pass when the directory is missing too', async () => {
      const path = join(work_dir, 'no-such-dir', 'run.jsonl')
      const errors: unknown[] = []
      const tail = spawn({ path, on_event: () => {}, on_io_error: (err) => errors.push(err) })
      // A watch that can't arm schedules nothing, so the drain settles rather
      // than spin: one try for the pass the tail starts with, one for drain's.
      await tail.drain()
      expect(errors.map((err) => Reflect.get(Object(err), 'code'))).toEqual(['ENOENT', 'ENOENT'])
      expect(open_watches()).toEqual([])
    })

    it('reads a deleted and recreated file from the top when its inode number comes back', async () => {
      gate.fixed_ino = 7
      const path = join(work_dir, 'reuse.jsonl')
      writeFileSync(path, emit_line('one') + emit_line('two'))
      const seen = collector()
      const tail = spawn({ path, on_event: seen.on_event })
      await tail.drain()
      expect(seen.texts).toEqual(['one', 'two'])

      // The pass that finds the path empty forgets the inode, so the new file
      // starts at offset 0 though it reports the old number and is longer.
      unlinkSync(path)
      await tail.drain()
      writeFileSync(path, emit_line('three') + emit_line('four') + emit_line('five'))
      await tail.drain()
      expect(seen.texts).toEqual(['one', 'two', 'three', 'four', 'five'])
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

    it('closes the file watch, and the directory watch while it waits', async () => {
      const present = join(work_dir, 'present.jsonl')
      writeFileSync(present, '')
      const waiting = join(work_dir, 'nested')
      mkdirSync(waiting)
      const tail_a = spawn({ path: present, on_event: () => {} })
      const tail_b = spawn({ path: join(waiting, 'missing.jsonl'), on_event: () => {} })
      await Promise.all([tail_a.drain(), tail_b.drain()])
      expect(open_watches()).toEqual([present, waiting])

      tail_a.stop()
      expect(open_watches()).toEqual([waiting])
      tail_b.stop()
      expect(open_watches()).toEqual([])
    })

    it('starts no watch from a pass that was in flight when it stopped', async () => {
      const path = join(work_dir, 'in-flight.jsonl')
      writeFileSync(path, emit_line('one'))
      const arm: StatArm = { entered: deferred(), release: deferred() }
      gate.stat_arm = arm
      const tail = spawn({ path, on_event: () => {} })
      await arm.entered.promise

      tail.stop()
      arm.release.resolve()
      await tail.drain()
      expect(gate.watches).toEqual([])
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
