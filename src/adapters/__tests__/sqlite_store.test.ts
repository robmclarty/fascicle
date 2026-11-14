import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { durable, sequence, step, suspend } from '#core'
import { sqlite_store, type SqliteStore } from '../sqlite_store.js'

const dirs: string[] = []
const open: SqliteStore[] = []

afterAll(() => {
  for (const store of open) store.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// A database file in a directory of its own, removed when the suite ends.
function fresh_file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fascicle-sqlite-'))
  dirs.push(dir)
  return join(dir, 'runs.db')
}

function store_over(path: string): SqliteStore {
  const store = sqlite_store({ path })
  open.push(store)
  return store
}

describe('sqlite_store values', () => {
  it('reads back what it wrote, as a copy that survives JSON', async () => {
    const store = store_over(':memory:')
    const value = { n: 1, list: ['a', { deep: true }], nothing: null }
    await store.set('k', value)
    expect(await store.get('k')).toEqual(value)
    expect(await store.get('k')).not.toBe(value)
  })

  it('reads a missing key, a stored null, and a stored undefined as a miss', async () => {
    const store = store_over(':memory:')
    await store.set('null', null)
    await store.set('undefined', undefined)
    expect(await store.get('missing')).toBeNull()
    expect(await store.get('null')).toBeNull()
    expect(await store.get('undefined')).toBeNull()
  })

  it('overwrites a value and deletes it', async () => {
    const store = store_over(':memory:')
    await store.set('k', 'first')
    await store.set('k', 'second')
    expect(await store.get('k')).toBe('second')
    await store.delete('k')
    expect(await store.get('k')).toBeNull()
    await expect(store.delete('k')).resolves.toBeUndefined()
  })

  it('keeps what one connection wrote for the next one over the same file', async () => {
    const path = fresh_file()
    const first = sqlite_store({ path })
    await first.scope('run').set('k', { kept: true })
    first.close()
    expect(await store_over(path).scope('run').get('k')).toEqual({ kept: true })
  })

  it('reads a row that is not JSON as a miss, and still gives it a version', async () => {
    const path = fresh_file()
    const store = store_over(path)
    await store.set('k', { whole: true })
    const raw = new DatabaseSync(path)
    raw.prepare('UPDATE fascicle_values SET value = ? WHERE key = ?').run('{ "whole": tr', 'k')
    raw.close()
    expect(await store.get('k')).toBeNull()
    const read = await store.get_versioned('k')
    expect(read?.value).toBeUndefined()
    expect(read?.version).toEqual(expect.any(String))
    expect(await store.set_if('k', 'mended', read?.version ?? '')).toBe(true)
    expect(await store.get('k')).toBe('mended')
  })
})

describe('sqlite_store scopes', () => {
  it('keeps a scope apart from its parent and from a prefix that only encodes alike', async () => {
    const store = store_over(':memory:')
    await store.set('k', 'root')
    await store.scope('a').set('k', 'a')
    await store.scope('a/b').set('k', 'a slash b')
    await store.scope('a').scope('b').set('k', 'a then b')
    await store.scope('a%2Fb').set('k', 'encoded look-alike')
    expect(await store.get('k')).toBe('root')
    expect(await store.scope('a').get('k')).toBe('a')
    expect(await store.scope('a/b').get('k')).toBe('a slash b')
    expect(await store.scope('a').scope('b').get('k')).toBe('a then b')
    expect(await store.scope('a%2Fb').get('k')).toBe('encoded look-alike')
  })

  it('clears a scope with everything nested in it, and nothing beside it', async () => {
    const store = store_over(':memory:')
    await store.set('k', 'root')
    await store.scope('a').set('k', 'a')
    await store.scope('a').scope('b').set('k', 'nested')
    await store.scope('a/b').set('k', 'named with a slash')
    await store.scope('a0').set('k', 'sorts just after')
    await store.scope('a.').set('k', 'sorts just before')
    await store.scope('a').claim('lease', 'one', 60_000)

    await store.scope('a').clear()

    expect(await store.scope('a').get('k')).toBeNull()
    expect(await store.scope('a').scope('b').get('k')).toBeNull()
    expect(await store.scope('a').claim('lease', 'two', 60_000)).toBe(true)
    expect(await store.get('k')).toBe('root')
    expect(await store.scope('a/b').get('k')).toBe('named with a slash')
    expect(await store.scope('a0').get('k')).toBe('sorts just after')
    expect(await store.scope('a.').get('k')).toBe('sorts just before')
  })

  it('keeps a version read in one scope from satisfying a write in another', async () => {
    const store = store_over(':memory:')
    await store.scope('a').set('k', 1)
    await store.scope('b').set('k', 1)
    const read = await store.scope('a').get_versioned('k')
    expect(await store.scope('b').set_if('k', 2, read?.version ?? '')).toBe(false)
    expect(await store.scope('a').set_if('k', 2, read?.version ?? '')).toBe(true)
    expect(await store.scope('b').get('k')).toBe(1)
  })
})

describe('sqlite_store conditional writes', () => {
  it('creates only an absent key, and replaces only the version it read', async () => {
    const store = store_over(':memory:')
    expect(await store.get_versioned('k')).toBeUndefined()
    expect(await store.set_if('k', 'first', null)).toBe(true)
    expect(await store.set_if('k', 'again', null)).toBe(false)
    const read = await store.get_versioned('k')
    expect(read?.value).toBe('first')
    expect(await store.set_if('k', 'second', read?.version ?? '')).toBe(true)
    expect(await store.set_if('k', 'stale', read?.version ?? '')).toBe(false)
    expect(await store.get('k')).toBe('second')
    expect((await store.get_versioned('k'))?.version).not.toBe(read?.version)
  })

  it('lets a create land again once the key is deleted', async () => {
    const store = store_over(':memory:')
    await store.set('k', 'old')
    const before = await store.get_versioned('k')
    await store.delete('k')
    expect(await store.set_if('k', 'stale', before?.version ?? '')).toBe(false)
    expect(await store.set_if('k', 'new', null)).toBe(true)
    expect(await store.get('k')).toBe('new')
  })
})

describe('sqlite_store claims', () => {
  it('refuses a second owner, renews for the first, and frees the key on release', async () => {
    const store = store_over(':memory:')
    expect(await store.claim('lease', 'one', 60_000)).toBe(true)
    expect(await store.claim('lease', 'two', 60_000)).toBe(false)
    expect(await store.claim('lease', 'one', 60_000)).toBe(true)
    await store.release('lease', 'two')
    expect(await store.claim('lease', 'two', 60_000)).toBe(false)
    await store.release('lease', 'one')
    expect(await store.claim('lease', 'two', 60_000)).toBe(true)
  })

  it('hands an expired claim to another owner, and keeps claims apart from values', async () => {
    const store = store_over(':memory:')
    await store.set('lease', 'a value under the same key')
    expect(await store.claim('lease', 'one', 15)).toBe(true)
    expect(await store.get('lease')).toBe('a value under the same key')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(await store.claim('lease', 'two', 60_000)).toBe(true)
    expect(await store.claim('lease', 'one', 60_000)).toBe(false)
  })

  it('lets exactly one of two stores over one file win a claim they race for', async () => {
    const path = fresh_file()
    const left = store_over(path)
    const right = store_over(path)
    for (let round = 0; round < 20; round += 1) {
      const key = `lease-${round}`
      const won = await Promise.all([
        left.scope('run').claim(key, 'left', 60_000),
        right.scope('run').claim(key, 'right', 60_000),
      ])
      expect(won.filter(Boolean)).toHaveLength(1)
    }
  })
})

describe('sqlite_store under durable', () => {
  it('suspends a run over one store and resumes it over a fresh one on the same file', async () => {
    const path = fresh_file()
    const drafts = { n: 0 }
    const flow = sequence([
      step('draft', (topic: string) => {
        drafts.n += 1
        return `${topic}: draft`
      }),
      suspend({
        id: 'approve',
        on: () => {},
        resume_schema: z.object({ ok: z.boolean() }),
        combine: (draft: string, decision) => `${draft} ${decision.ok ? 'approved' : 'refused'}`,
      }),
    ])
    const quiet = { install_signal_handlers: false } as const

    const first = sqlite_store({ path })
    expect(await durable({ store: first }).start('r', flow, 'pricing', quiet)).toMatchObject({
      kind: 'suspended',
      id: 'approve',
    })
    first.close()

    const runs = durable({ store: store_over(path) })
    expect(await runs.get('r')).toMatchObject({ kind: 'suspended', id: 'approve' })
    expect(await runs.resume('r', flow, { approve: { ok: true } }, quiet)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'pricing: draft approved',
    })
    expect(await runs.delete('r')).toBe(true)
    expect(await runs.get('r')).toBeUndefined()
  })
})

describe('sqlite_store loading', () => {
  it('refuses any call once it is closed', async () => {
    const store = sqlite_store({ path: ':memory:' })
    store.close()
    await expect(store.get('k')).rejects.toThrow()
  })

  it('waits as long as timeout_ms for a lock another connection holds, then fails', async () => {
    const path = fresh_file()
    const store = sqlite_store({ path, timeout_ms: 30 })
    open.push(store)
    const holder = new DatabaseSync(path)
    holder.exec('BEGIN IMMEDIATE')
    const started = Date.now()
    await expect(store.set('k', 1)).rejects.toThrow(/locked/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
    holder.exec('COMMIT')
    holder.close()
    await store.set('k', 2)
    expect(await store.get('k')).toBe(2)
  })
})
