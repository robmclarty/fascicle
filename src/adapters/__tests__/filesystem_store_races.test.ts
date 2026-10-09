/**
 * The claim interleavings real disk can't produce on demand: another claimer
 * acting between this claimer's read and its write. Each test swaps one
 * filesystem call for a single invocation (a stale directory listing, a
 * failing write or link) and lets every other call reach the real disk.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filesystem_store } from '../filesystem_store.js'

// A swap that resolves undefined passes its call through to the real disk,
// which lets a test aim at the third call rather than the first.
const swaps = vi.hoisted(() => ({
  readdir: [] as Array<() => Promise<string[]> | undefined>,
  link: [] as Array<() => Promise<void>>,
  writeFile: [] as Array<() => Promise<void>>,
  readFile: [] as Array<() => Promise<string>>,
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
