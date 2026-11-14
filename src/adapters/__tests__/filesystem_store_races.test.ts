/**
 * The claim interleavings real disk can't produce on demand: another claimer
 * acting between this claimer's read and its write. Each test swaps one
 * filesystem call for a single invocation (a stale directory listing, a
 * failing write or link) and lets every other call reach the real disk.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, type Stats, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filesystem_store } from '../filesystem_store.js'

// A swap that resolves undefined passes its call through to the real disk,
// which lets a test aim at the third call rather than the first.
const swaps = vi.hoisted(() => ({
  readdir: [] as Array<() => Promise<string[]> | undefined>,
  link: [] as Array<() => Promise<void>>,
  writeFile: [] as Array<() => Promise<void> | undefined>,
  readFile: [] as Array<() => Promise<string | Buffer> | undefined>,
  mkdir: [] as Array<() => Promise<undefined> | undefined>,
  stat: [] as Array<() => Promise<Stats> | undefined>,
  rmdir: [] as Array<() => Promise<void> | undefined>,
}))

vi.mock('node:fs/promises', async (import_original) => {
  const real = await import_original<typeof import('node:fs/promises')>()
  return {
    ...real,
    readdir: (path: string) => swaps.readdir.shift()?.() ?? real.readdir(path),
    link: (from: string, to: string) => swaps.link.shift()?.() ?? real.link(from, to),
    writeFile: (path: string, data: string) => swaps.writeFile.shift()?.() ?? real.writeFile(path, data),
    readFile: (path: string, encoding: 'utf8') =>
      swaps.readFile.shift()?.() ?? real.readFile(path, encoding),
    mkdir: (path: string, options?: { recursive: boolean }) =>
      swaps.mkdir.shift()?.() ?? real.mkdir(path, options),
    stat: (path: string) => swaps.stat.shift()?.() ?? real.stat(path),
    rmdir: (path: string) => swaps.rmdir.shift()?.() ?? real.rmdir(path),
  }
})

let work_dir = ''
let claim_dir = ''

function fs_error(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code })
}

function write_claim(generation: number, owner: string, expires_at: number): void {
  writeFileSync(join(claim_dir, `${generation}.json`), JSON.stringify({ owner, expires_at }))
}

function read_claim(generation: number): unknown {
  return JSON.parse(readFileSync(join(claim_dir, `${generation}.json`), 'utf8'))
}

beforeEach(async () => {
  work_dir = mkdtempSync(join(tmpdir(), 'fascicle-fs-races-'))
  // Learn the claim directory's name from the store itself.
  await filesystem_store({ root_dir: work_dir }).claim('k', 'setup', 1)
  const [name] = readdirSync(work_dir)
  claim_dir = join(work_dir, name ?? '')
  rmSync(join(claim_dir, '1.json'))
})

afterEach(() => {
  swaps.readdir.length = 0
  swaps.link.length = 0
  swaps.writeFile.length = 0
  swaps.readFile.length = 0
  swaps.mkdir.length = 0
  swaps.stat.length = 0
  swaps.rmdir.length = 0
  rmSync(work_dir, { recursive: true, force: true })
})

describe('filesystem_store claim races', () => {
  it('loses when a newer generation shows up after it created its own', async () => {
    // This claimer lists the directory as empty, but by the time it confirms,
    // another claimer has moved on to generation 3.
    write_claim(3, 'other', Date.now() + 60_000)
    swaps.readdir.push(async () => [])
    const store = filesystem_store({ root_dir: work_dir })
    expect(await store.claim('k', 'late', 60_000)).toBe(false)
    expect(readdirSync(claim_dir).toSorted()).toEqual(['1.json', '3.json'])
  })

  it('loses a renewal when a newer generation shows up before it confirms', async () => {
    write_claim(1, 'owner', Date.now() + 60_000)
    write_claim(2, 'other', Date.now() + 60_000)
    swaps.readdir.push(async () => ['1.json'])
    const store = filesystem_store({ root_dir: work_dir })
    expect(await store.claim('k', 'owner', 60_000)).toBe(false)
    expect(read_claim(2)).toMatchObject({ owner: 'other' })
  })

  it('refuses rather than overwrite when another claimer links the next generation first', async () => {
    swaps.link.push(() => Promise.reject(fs_error('EEXIST')))
    const store = filesystem_store({ root_dir: work_dir })
    expect(await store.claim('k', 'late', 60_000)).toBe(false)
    expect(readdirSync(claim_dir)).toEqual([])
  })

  it('surfaces any other link failure, and removes its temporary file', async () => {
    swaps.link.push(() => Promise.reject(fs_error('EPERM')))
    const store = filesystem_store({ root_dir: work_dir })
    await expect(store.claim('k', 'first', 60_000)).rejects.toThrow('EPERM: simulated')
    expect(readdirSync(claim_dir)).toEqual([])
  })

  it('surfaces a link failure that is not an Error untouched', async () => {
    swaps.link.push(() => Promise.reject('EEXIST'))
    const store = filesystem_store({ root_dir: work_dir })
    await expect(store.claim('k', 'first', 60_000)).rejects.toBe('EEXIST')
  })

  it('surfaces a link failure that carries no code', async () => {
    swaps.link.push(() => Promise.reject(new Error('no code here')))
    const store = filesystem_store({ root_dir: work_dir })
    await expect(store.claim('k', 'first', 60_000)).rejects.toThrow('no code here')
  })

  it('treats a generation that vanished between listing and reading as free', async () => {
    swaps.readdir.push(async () => ['5.json'])
    const store = filesystem_store({ root_dir: work_dir })
    expect(await store.claim('k', 'first', 60_000)).toBe(true)
    expect(readdirSync(claim_dir)).toEqual(['6.json'])
    expect(read_claim(6)).toMatchObject({ owner: 'first' })
  })

  it('releases quietly when the claim directory vanishes before the rewrite lands', async () => {
    write_claim(1, 'owner', Date.now() + 60_000)
    swaps.writeFile.push(() => Promise.reject(fs_error('ENOENT')))
    const store = filesystem_store({ root_dir: work_dir })
    await expect(store.release('k', 'owner')).resolves.toBeUndefined()
  })

  it('surfaces any other failure to rewrite a released claim', async () => {
    write_claim(1, 'owner', Date.now() + 60_000)
    swaps.writeFile.push(() => Promise.reject(fs_error('EACCES')))
    const store = filesystem_store({ root_dir: work_dir })
    await expect(store.release('k', 'owner')).rejects.toThrow('EACCES: simulated')
  })

  it('surfaces a directory listing that fails for a reason other than absence', async () => {
    swaps.readdir.push(() => Promise.reject(fs_error('EIO')))
    const store = filesystem_store({ root_dir: work_dir })
    await expect(store.claim('k', 'first', 60_000)).rejects.toThrow('EIO: simulated')
  })

  it('surfaces a value it cannot read for a reason other than absence', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.set('k', { v: 1 })
    swaps.readFile.push(() => Promise.reject(fs_error('EIO')))
    await expect(store.get('k')).rejects.toThrow('EIO: simulated')
  })

  it("won't take a live claim whose generation it failed to read", async () => {
    write_claim(1, 'owner', Date.now() + 60_000)
    swaps.readFile.push(() => Promise.reject(fs_error('EMFILE')))
    const store = filesystem_store({ root_dir: work_dir })
    await expect(store.claim('k', 'thief', 60_000)).rejects.toThrow('EMFILE: simulated')
    expect(readdirSync(claim_dir)).toEqual(['1.json'])
  })

  it('prunes past an older generation that another claimer already deleted', async () => {
    // The first two listings reach the disk, and the prune's listing names a
    // generation that's no longer there.
    swaps.readdir.push(
      () => undefined,
      () => undefined,
      async () => ['0.json', '1.json'],
    )
    const store = filesystem_store({ root_dir: work_dir })
    expect(await store.claim('k', 'first', 60_000)).toBe(true)
    expect(readdirSync(claim_dir)).toEqual(['1.json'])
  })

  it('reads an absent claim directory as holding no generations', async () => {
    rmSync(claim_dir, { recursive: true })
    mkdirSync(claim_dir)
    swaps.readdir.push(() => Promise.reject(fs_error('ENOENT')))
    const store = filesystem_store({ root_dir: work_dir })
    expect(await store.claim('k', 'first', 60_000)).toBe(true)
    expect(read_claim(1)).toMatchObject({ owner: 'first' })
  })
})

describe('filesystem_store conditional write races', () => {
  // The store under test is a scope, so a test can clear it mid-write the way
  // deleting a durable run does.
  const scope_dir = (): string => {
    const name = readdirSync(work_dir).find((entry) => entry.endsWith('.scope'))
    return join(work_dir, name ?? '')
  }
  const value_file = (): string => {
    const name = readdirSync(scope_dir()).find((entry) => entry.endsWith('.json'))
    return join(scope_dir(), name ?? '')
  }
  const locks = (): string[] => readdirSync(scope_dir()).filter((name) => name.endsWith('.lock'))
  const temporary_files = (): string[] =>
    readdirSync(scope_dir()).filter((name) => name.endsWith('.tmp'))

  it('refuses a write whose scope was cleared and made again after it began', async () => {
    const store = filesystem_store({ root_dir: work_dir }).scope('run')
    await store.set('k', { v: 1 })
    const read = await store.get_versioned('k')
    const dir = scope_dir()
    const file = value_file()
    // By the time the read of the value answers, the run was deleted and a
    // new one holds the same bytes.
    swaps.readFile.push(async () => {
      rmSync(dir, { recursive: true })
      mkdirSync(dir)
      writeFileSync(file, '{"v":1}')
      return Buffer.from('{"v":1}')
    })
    expect(await store.set_if('k', { v: 2 }, read?.version ?? '')).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{"v":1}')
    expect(readdirSync(dir)).toEqual([file.slice(dir.length + 1)])
  })

  it('reads a directory that vanished before the temporary file was written as a conflict', async () => {
    const store = filesystem_store({ root_dir: work_dir }).scope('run')
    await store.set('k', { v: 1 })
    const read = await store.get_versioned('k')
    swaps.writeFile.push(() => Promise.reject(fs_error('ENOENT')))
    expect(await store.set_if('k', { v: 2 }, read?.version ?? '')).toBe(false)
    expect(await store.get('k')).toEqual({ v: 1 })
  })

  it('surfaces any other failure of a conditional write, and lets the lock go', async () => {
    const store = filesystem_store({ root_dir: work_dir }).scope('run')
    await store.set('k', { v: 1 })
    const read = await store.get_versioned('k')
    swaps.writeFile.push(() => Promise.reject(fs_error('EACCES')))
    await expect(store.set_if('k', { v: 2 }, read?.version ?? '')).rejects.toThrow(
      'EACCES: simulated',
    )
    expect(locks()).toEqual([])
    expect(await store.get('k')).toEqual({ v: 1 })
  })

  it('surfaces a failure that is not an Error untouched', async () => {
    const store = filesystem_store({ root_dir: work_dir }).scope('run')
    await store.set('k', { v: 1 })
    swaps.writeFile.push(() => Promise.reject('ENOENT'))
    await expect(store.set_if('k', { v: 2 }, 'any version')).rejects.toBe('ENOENT')
  })

  it('removes its temporary file when the value cannot be read', async () => {
    const store = filesystem_store({ root_dir: work_dir }).scope('run')
    await store.set('k', { v: 1 })
    swaps.readFile.push(() => Promise.reject(fs_error('EIO')))
    await expect(store.set_if('k', { v: 2 }, 'any version')).rejects.toThrow('EIO: simulated')
    expect(temporary_files()).toEqual([])
  })

  it('surfaces a versioned read that fails for a reason other than absence', async () => {
    const store = filesystem_store({ root_dir: work_dir }).scope('run')
    await store.set('k', { v: 1 })
    swaps.readFile.push(() => Promise.reject(fs_error('EIO')))
    await expect(store.get_versioned('k')).rejects.toThrow('EIO: simulated')
  })

})

describe('filesystem_store write lock races', () => {
  const scope_dir = (): string => {
    const name = readdirSync(work_dir).find((entry) => entry.endsWith('.scope'))
    return join(work_dir, name ?? '')
  }
  // The lock directory of the one key these tests write, whose name the
  // value's file gives away.
  const lock_dir = (): string => {
    const name = readdirSync(scope_dir()).find((entry) => entry.endsWith('.json'))
    return join(scope_dir(), (name ?? '').replace(/\.json$/, '.lock'))
  }
  const recovery_claim = (generation: number): string =>
    join(scope_dir(), 'lock.recovery', `${generation}.json`)

  // Make the lock look as if it was taken `ms` milliseconds ago.
  function age(ms: number): void {
    const then = new Date(Date.now() - ms)
    utimesSync(lock_dir(), then, then)
  }

  async function store_with_value(): Promise<ReturnType<ReturnType<typeof filesystem_store>['scope']>> {
    const store = filesystem_store({ root_dir: work_dir }).scope('run')
    await store.set('k', { v: 1 })
    return store
  }

  it('asks again for a held lock every couple of milliseconds', async () => {
    const store = await store_with_value()
    const lock = lock_dir()
    mkdirSync(lock)
    const waits: number[] = []
    const real_set_timeout = globalThis.setTimeout
    real_set_timeout(() => rmSync(lock, { recursive: true }), 40)
    const spy = vi.spyOn(globalThis, 'setTimeout')
    spy.mockImplementation(((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0)
      return real_set_timeout(fn, ms)
    }) as typeof setTimeout)
    await store.set('k', { v: 2 })
    spy.mockRestore()
    expect(waits.length).toBeGreaterThan(1)
    expect(new Set(waits)).toEqual(new Set([2]))
    expect(await store.get('k')).toEqual({ v: 2 })
  })

  it('takes the lock of an uncontended write without waiting at all', async () => {
    const store = await store_with_value()
    const spy = vi.spyOn(globalThis, 'setTimeout')
    await Promise.all([store.set('k', { v: 2 }), store.delete('k'), store.set('k', { v: 3 })])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    expect(await store.get('k')).toEqual({ v: 3 })
  })

  it('surfaces a lock it cannot make for a reason other than being held', async () => {
    const store = await store_with_value()
    swaps.mkdir.push(() => Promise.reject(fs_error('EACCES')))
    await expect(store.set('k', { v: 2 })).rejects.toThrow('EACCES: simulated')
    expect(await store.get('k')).toEqual({ v: 1 })
    // The failed write left the queue, so the next one goes ahead.
    await store.set('k', { v: 3 })
    expect(await store.get('k')).toEqual({ v: 3 })
  })

  it('makes the directory again when it vanished, and then takes the lock', async () => {
    const store = await store_with_value()
    const dir = scope_dir()
    rmSync(dir, { recursive: true })
    await store.set('k', { v: 2 })
    expect(readdirSync(dir)).toHaveLength(1)
    expect(await store.get('k')).toEqual({ v: 2 })
  })

  it('reads a held lock that is let go before it can be looked at as free to ask for again', async () => {
    const store = await store_with_value()
    const lock = lock_dir()
    mkdirSync(lock)
    swaps.stat.push(() => {
      rmSync(lock, { recursive: true })
      return Promise.reject(fs_error('ENOENT'))
    })
    await store.set('k', { v: 2 })
    expect(await store.get('k')).toEqual({ v: 2 })
    expect(existsSync(join(scope_dir(), 'lock.recovery'))).toBe(false)
  })

  it('surfaces a held lock it cannot look at', async () => {
    const store = await store_with_value()
    mkdirSync(lock_dir())
    swaps.stat.push(() => Promise.reject(fs_error('EIO')))
    await expect(store.set('k', { v: 2 })).rejects.toThrow('EIO: simulated')
  })

  it('lets go quietly of a lock that vanished with its scope', async () => {
    const store = await store_with_value()
    swaps.rmdir.push(() => Promise.reject(fs_error('ENOENT')))
    await store.set('k', { v: 2 })
    expect(await store.get('k')).toEqual({ v: 2 })
  })

  it('surfaces any other failure to let the lock go', async () => {
    const store = await store_with_value()
    swaps.rmdir.push(() => Promise.reject(fs_error('EIO')))
    await expect(store.set('k', { v: 2 })).rejects.toThrow('EIO: simulated')
  })

  it('leaves a lock alone when it was taken afresh before the recovery claim was held', async () => {
    const store = await store_with_value()
    const lock = lock_dir()
    mkdirSync(lock)
    age(60_000)
    // The writer sees the abandoned lock. Before it holds the claim, another
    // writer recovers that lock and takes a fresh one.
    swaps.stat.push(
      () => undefined,
      () => {
        const now = new Date()
        utimesSync(lock, now, now)
        return undefined
      },
    )
    const landed = vi.fn()
    const waiting = store.set('k', { v: 2 }).then(landed)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(landed).not.toHaveBeenCalled()
    expect(existsSync(lock)).toBe(true)
    expect(JSON.parse(readFileSync(recovery_claim(1), 'utf8'))).toMatchObject({ expires_at: 0 })
    rmSync(lock, { recursive: true })
    await waiting
    expect(await store.get('k')).toEqual({ v: 2 })
  })

  it('holds the recovery claim for ten seconds unless it lets it go', async () => {
    const store = await store_with_value()
    mkdirSync(lock_dir())
    age(60_000)
    let remaining = 0
    // The second look at the lock is made with the claim held.
    swaps.stat.push(
      () => undefined,
      () => {
        const claim = JSON.parse(readFileSync(recovery_claim(1), 'utf8')) as { expires_at: number }
        remaining = claim.expires_at - Date.now()
        return undefined
      },
    )
    await store.set('k', { v: 2 })
    expect(remaining).toBeGreaterThan(9_000)
    expect(remaining).toBeLessThanOrEqual(10_000)
    expect(await store.get('k')).toEqual({ v: 2 })
  })

  it('lets the recovery claim go when the lock cannot be looked at again', async () => {
    const store = await store_with_value()
    mkdirSync(lock_dir())
    age(60_000)
    swaps.stat.push(
      () => undefined,
      () => Promise.reject(fs_error('EIO')),
    )
    await expect(store.set('k', { v: 2 })).rejects.toThrow('EIO: simulated')
    expect(JSON.parse(readFileSync(recovery_claim(1), 'utf8'))).toMatchObject({ expires_at: 0 })
  })

  it('waits a couple of milliseconds when another writer holds the recovery claim', async () => {
    const store = await store_with_value()
    const lock = lock_dir()
    mkdirSync(lock)
    age(60_000)
    mkdirSync(join(scope_dir(), 'lock.recovery'))
    writeFileSync(recovery_claim(1), JSON.stringify({ owner: 'another writer', expires_at: Date.now() + 60_000 }))
    const waits: number[] = []
    const real_set_timeout = globalThis.setTimeout
    real_set_timeout(() => rmSync(lock, { recursive: true }), 40)
    const spy = vi.spyOn(globalThis, 'setTimeout')
    spy.mockImplementation(((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0)
      return real_set_timeout(fn, ms)
    }) as typeof setTimeout)
    await store.set('k', { v: 2 })
    spy.mockRestore()
    expect(waits.length).toBeGreaterThan(1)
    expect(new Set(waits)).toEqual(new Set([2]))
    expect(readdirSync(join(scope_dir(), 'lock.recovery'))).toEqual(['1.json'])
  })
})
