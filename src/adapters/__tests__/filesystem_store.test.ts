import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filesystem_store } from '../filesystem_store.js'

let work_dir = ''

beforeEach(() => {
  work_dir = mkdtempSync(join(tmpdir(), 'fascicle-fs-store-'))
})

afterEach(() => {
  rmSync(work_dir, { recursive: true, force: true })
})

describe('filesystem_store', () => {
  it('get on a missing key returns null', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    const v = await store.get('does-not-exist')
    expect(v).toBeNull()
  })

  it('set then get round-trips a JSON value', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    const value = { candidate: 'a', converged: true, rounds: 2 }
    await store.set('k1', value)
    const read = await store.get('k1')
    expect(read).toEqual(value)
  })

  it('set is atomic: no .tmp file remains after completion', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.set('k2', { x: 1 })
    const files = readdirSync(work_dir)
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false)
    expect(files.some((f) => f.endsWith('.json'))).toBe(true)
  })

  it('a corrupted JSON payload at a key reads as a miss', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.set('k3', { ok: true })
    const files = readdirSync(work_dir)
    const target = files.find((f) => f.endsWith('.json'))
    if (target === undefined) throw new Error('expected a json file')
    writeFileSync(join(work_dir, target), '{ not json')
    const read = await store.get('k3')
    expect(read).toBeNull()
  })

  it('a leftover .tmp file at a key is ignored on get (crashed write simulation)', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    // Write only the tmp counterpart, never rename into place.
    writeFileSync(join(work_dir, 'anything.tmp'), '{ half-written')
    const read = await store.get('nothing-here')
    expect(read).toBeNull()
  })

  it('delete removes the key; subsequent get returns null', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.set('k4', { a: 1 })
    await store.delete('k4')
    const read = await store.get('k4')
    expect(read).toBeNull()
  })

  it('delete on a missing key does not throw', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await expect(store.delete('no-such-key')).resolves.toBeUndefined()
  })

  it('overwrites an existing value atomically on set', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.set('k5', { v: 1 })
    await store.set('k5', { v: 2 })
    const read = await store.get('k5')
    expect(read).toEqual({ v: 2 })
  })

  it('keys with characters that require sanitization still round-trip', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    const key = 'build:abc/def?x=1'
    await store.set(key, { ok: true })
    const read = await store.get(key)
    expect(read).toEqual({ ok: true })
  })

  it('writes valid JSON to disk', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.set('k6', { a: 'b' })
    const files = readdirSync(work_dir)
    const target = files.find((f) => f.endsWith('.json'))
    if (target === undefined) throw new Error('expected a json file')
    const raw = await readFile(join(work_dir, target), 'utf8')
    expect(JSON.parse(raw)).toEqual({ a: 'b' })
  })
})

// The on-disk name the store gives a key or a prefix. Pinned here, because a
// change to the encoding would orphan every store already on disk.
function disk_name(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 12)
  return `${key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)}.${hash}`
}

function read_json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('filesystem_store values on disk', () => {
  it('keeps a key at <slug>.<hash>.json under the root', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.set('build:abc/def', { ok: true })
    expect(readdirSync(work_dir)).toEqual([`${disk_name('build:abc/def')}.json`])
    expect(disk_name('build:abc/def')).toMatch(/^build_abc_def\.[0-9a-f]{12}$/)
  })

  it('cuts a long key to 64 characters before the hash', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.set('k'.repeat(100), 1)
    expect(readdirSync(work_dir)).toEqual([`${'k'.repeat(64)}.${disk_name('k'.repeat(100)).slice(-12)}.json`])
  })

  it('writes undefined, or a value JSON has no text for, as null', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.set('undefined', undefined)
    await store.set('function', () => 1)
    expect(readFileSync(join(work_dir, `${disk_name('undefined')}.json`), 'utf8')).toBe('null')
    expect(readFileSync(join(work_dir, `${disk_name('function')}.json`), 'utf8')).toBe('null')
    expect(await store.get('undefined')).toBeNull()
  })
})

describe('filesystem_store scopes', () => {
  it('keeps a scope in a <prefix>.scope directory beside the values', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.scope('run-1').set('k', 1)
    const scope_dir = join(work_dir, `${disk_name('run-1')}.scope`)
    expect(readdirSync(work_dir)).toEqual([`${disk_name('run-1')}.scope`])
    expect(read_json(join(scope_dir, `${disk_name('k')}.json`))).toBe(1)
  })

  it("nests a scope inside its parent scope's directory", async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.scope('a').scope('b').set('k', 'nested')
    const nested = join(work_dir, `${disk_name('a')}.scope`, `${disk_name('b')}.scope`)
    expect(read_json(join(nested, `${disk_name('k')}.json`))).toBe('nested')
  })

  it("clear deletes the scope's directory and nothing beside it", async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.set('k', 'root')
    await store.scope('a').set('k', 'a')
    await store.scope('a').claim('lease', 'first', 60_000)
    await store.scope('b').set('k', 'b')
    await store.scope('a').clear()
    expect(readdirSync(work_dir).toSorted()).toEqual(
      [`${disk_name('b')}.scope`, `${disk_name('k')}.json`].toSorted(),
    )
  })
})

describe('filesystem_store claims', () => {
  const claim_file = (key: string, generation: number): string =>
    join(work_dir, `${disk_name(key)}.claim`, `${generation}.json`)
  const generations = (key: string): string[] =>
    readdirSync(join(work_dir, `${disk_name(key)}.claim`)).toSorted()

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('takes a free key as generation 1 of a <key>.claim directory', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    expect(await store.claim('k', 'first', 100)).toBe(true)
    expect(generations('k')).toEqual(['1.json'])
    expect(read_json(claim_file('k', 1))).toEqual({ owner: 'first', expires_at: 1_000_100 })
  })

  it('renews a live claim in place with a later expiry', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.claim('k', 'first', 100)
    vi.setSystemTime(1_000_050)
    expect(await store.claim('k', 'first', 100)).toBe(true)
    expect(generations('k')).toEqual(['1.json'])
    expect(read_json(claim_file('k', 1))).toEqual({ owner: 'first', expires_at: 1_000_150 })
  })

  it('refuses another owner while the claim is live, and leaves it untouched', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.claim('k', 'first', 100)
    vi.setSystemTime(1_000_099)
    expect(await store.claim('k', 'second', 100)).toBe(false)
    expect(generations('k')).toEqual(['1.json'])
    expect(read_json(claim_file('k', 1))).toEqual({ owner: 'first', expires_at: 1_000_100 })
  })

  it('passes a claim that expires this instant to the next generation and prunes the old one', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.claim('k', 'first', 100)
    vi.setSystemTime(1_000_100)
    expect(await store.claim('k', 'second', 100)).toBe(true)
    expect(generations('k')).toEqual(['2.json'])
    expect(read_json(claim_file('k', 2))).toEqual({ owner: 'second', expires_at: 1_000_200 })
  })

  it('makes an owner whose claim expired take it back as a new generation', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.claim('k', 'first', 100)
    vi.setSystemTime(1_000_500)
    expect(await store.claim('k', 'first', 100)).toBe(true)
    expect(generations('k')).toEqual(['2.json'])
  })

  it('releases by rewriting the claim as expired under the same generation', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.claim('k', 'first', 100)
    await store.release('k', 'first')
    expect(read_json(claim_file('k', 1))).toEqual({ owner: 'first', expires_at: 0 })
    expect(await store.claim('k', 'second', 100)).toBe(true)
    expect(generations('k')).toEqual(['2.json'])
  })

  it('leaves the claim alone when another owner releases it', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.claim('k', 'first', 100)
    await store.release('k', 'second')
    expect(read_json(claim_file('k', 1))).toEqual({ owner: 'first', expires_at: 1_000_100 })
  })

  it('releases quietly when the claim directory is gone', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    await store.claim('k', 'first', 100)
    rmSync(join(work_dir, `${disk_name('k')}.claim`), { recursive: true })
    await expect(store.release('k', 'first')).resolves.toBeUndefined()
    expect(readdirSync(work_dir)).toEqual([])
  })

  it('treats a generation that holds no claim as free', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    const dir = join(work_dir, `${disk_name('k')}.claim`)
    mkdirSync(dir)
    const not_claims = ['{ not json', 'null', '"text"', '{"owner":7,"expires_at":9e15}', '{"owner":"x"}']
    for (const [i, content] of not_claims.entries()) {
      writeFileSync(join(dir, `${i * 2 + 1}.json`), content)
      expect(await store.claim('k', `owner-${i}`, 100)).toBe(true)
      expect(generations('k')).toEqual([`${i * 2 + 2}.json`])
      rmSync(join(dir, `${i * 2 + 2}.json`))
    }
  })

  it('leaves alone a generation that names an owner but no expiry', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    const dir = join(work_dir, `${disk_name('k')}.claim`)
    mkdirSync(dir)
    writeFileSync(join(dir, '1.json'), JSON.stringify({ owner: 'first' }))
    await store.release('k', 'first')
    expect(read_json(join(dir, '1.json'))).toEqual({ owner: 'first' })
  })

  it('ignores temporary files and stray names in a claim directory', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    const dir = join(work_dir, `${disk_name('k')}.claim`)
    mkdirSync(dir)
    for (const name of ['9.json.abcd1234.tmp', 'notes.txt', '8.jsonx', 'x7.json']) {
      writeFileSync(join(dir, name), JSON.stringify({ owner: 'ghost', expires_at: 9e15 }))
    }
    expect(await store.claim('k', 'first', 100)).toBe(true)
    expect(read_json(join(dir, '1.json'))).toEqual({ owner: 'first', expires_at: 1_000_100 })
  })

  it('judges a claim by its newest generation', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    const dir = join(work_dir, `${disk_name('k')}.claim`)
    mkdirSync(dir)
    writeFileSync(join(dir, '2.json'), JSON.stringify({ owner: 'old', expires_at: 9e15 }))
    writeFileSync(join(dir, '10.json'), JSON.stringify({ owner: 'new', expires_at: 9e15 }))
    expect(await store.claim('k', 'old', 100)).toBe(false)
    expect(await store.claim('k', 'new', 100)).toBe(true)
    expect(read_json(join(dir, '10.json'))).toEqual({ owner: 'new', expires_at: 1_000_100 })
  })

  it('fails loudly when a file sits where the claim directory belongs', async () => {
    const store = filesystem_store({ root_dir: work_dir })
    writeFileSync(join(work_dir, `${disk_name('k')}.claim`), 'not a directory')
    await expect(store.claim('k', 'first', 100)).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(store.release('k', 'first')).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
