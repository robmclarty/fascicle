/**
 * Unit tests for `no_follow.ts`, against real files: a regular file, a
 * symbolic link, a second hard link, a directory, and a FIFO. Two passthrough
 * module mocks reach what real files can't. `node:fs` drops `O_NOFOLLOW` from
 * `constants` while a test asks it to, as Windows leaves it out, and
 * `node:fs/promises` records every handle `open` hands out and whether it was
 * closed, and can make a handle's `stat` fail. Disarmed, both are transparent.
 */

import { execFileSync } from 'node:child_process'
import { constants, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { no_follow_flags, open_unfollowed } from '../no_follow.js'

const gate = vi.hoisted(() => ({
  drop_no_follow: false,
  stat_fails: false,
  handles: [] as Array<{ closed: boolean }>,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    get constants() {
      return gate.drop_no_follow ? { ...actual.constants, O_NOFOLLOW: undefined } : actual.constants
    },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const record = { closed: false }
      gate.handles.push(record)
      const close = handle.close.bind(handle)
      Object.assign(handle, {
        close: async () => {
          record.closed = true
          await close()
        },
      })
      if (gate.stat_fails) {
        Object.assign(handle, { stat: async () => { throw new Error('mock stat failure') } })
      }
      return handle
    },
  }
})

let work_dir = ''

beforeEach(() => {
  work_dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-no-follow-'))
  gate.drop_no_follow = false
  gate.stat_fails = false
  gate.handles = []
})

afterEach(() => {
  rmSync(work_dir, { recursive: true, force: true })
})

describe('no_follow_flags', () => {
  it('opens for reading without following a link or waiting on a FIFO', () => {
    const flags = no_follow_flags()
    expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
    expect(flags & (constants.O_WRONLY | constants.O_RDWR)).toBe(0)
  })

  it('throws where the platform has no O_NOFOLLOW, rather than follow a link', () => {
    gate.drop_no_follow = true
    expect(() => no_follow_flags()).toThrow(
      new Error("follow_links: false needs O_NOFOLLOW, which this platform doesn't have"),
    )
  })
})

describe('open_unfollowed', () => {
  it('opens a regular file with no other name, and hands over a handle that reads it', async () => {
    const path = join(work_dir, 'run.jsonl')
    writeFileSync(path, 'one\n')
    const opened = await open_unfollowed(path, no_follow_flags())
    if (opened.kind !== 'opened') throw new Error(`expected a handle, got ${opened.kind}`)
    try {
      expect(opened.stats.isFile()).toBe(true)
      expect(opened.stats.size).toBe(4)
      expect((await opened.handle.readFile()).toString('utf8')).toBe('one\n')
      expect(gate.handles).toEqual([{ closed: false }])
    } finally {
      await opened.handle.close()
    }
  })

  it('refuses a link at the last name with the ELOOP the open failed with', async () => {
    const target = join(work_dir, 'secret')
    writeFileSync(target, 'private\n')
    const path = join(work_dir, 'run.jsonl')
    symlinkSync(target, path)
    const opened = await open_unfollowed(path, no_follow_flags())
    expect(opened.kind).toBe('refused')
    expect(opened).toMatchObject({ error: { code: 'ELOOP' } })
    expect(gate.handles).toEqual([])
  })

  it('refuses a file with a second hard link, closing the handle it opened', async () => {
    const path = join(work_dir, 'run.jsonl')
    writeFileSync(path, 'one\n')
    linkSync(path, join(work_dir, 'other-name'))
    expect(await open_unfollowed(path, no_follow_flags())).toEqual({
      kind: 'refused',
      error: new Error(
        `follow_links is false, so the viewer won't read ${path}: it's one of 2 hard links to the same file`,
      ),
    })
    expect(gate.handles).toEqual([{ closed: true }])
  })

  it('refuses a directory at the path, closing the handle it opened', async () => {
    const path = join(work_dir, 'run.jsonl')
    mkdirSync(path)
    expect(await open_unfollowed(path, no_follow_flags())).toEqual({
      kind: 'refused',
      error: new Error(`follow_links is false, so the viewer won't read ${path}: it isn't a regular file`),
    })
    expect(gate.handles).toEqual([{ closed: true }])
  })

  it.skipIf(process.platform === 'win32')('refuses a FIFO without waiting for a writer', async () => {
    const path = join(work_dir, 'run.jsonl')
    execFileSync('mkfifo', [path])
    const opened = await open_unfollowed(path, no_follow_flags())
    expect(opened).toEqual({
      kind: 'refused',
      error: new Error(`follow_links is false, so the viewer won't read ${path}: it isn't a regular file`),
    })
  })

  it('fails, with nothing to close, when nothing is at the path', async () => {
    const opened = await open_unfollowed(join(work_dir, 'missing.jsonl'), no_follow_flags())
    expect(opened.kind).toBe('failed')
    expect(opened).toMatchObject({ error: { code: 'ENOENT' } })
    expect(gate.handles).toEqual([])
  })

  it('fails, closing the handle, when the stat of what it opened fails', async () => {
    const path = join(work_dir, 'run.jsonl')
    writeFileSync(path, 'one\n')
    gate.stat_fails = true
    expect(await open_unfollowed(path, no_follow_flags())).toEqual({
      kind: 'failed',
      error: new Error('mock stat failure'),
    })
    expect(gate.handles).toEqual([{ closed: true }])
  })
})
