import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { object_store, type ObjectClient } from '../object_store.js'
import {
  losing_answers,
  memory_client,
  type Call,
  type MemoryClient,
} from '../../../test/fixtures/memory_object_client.js'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

const puts_of = (client: MemoryClient): Call[] => client.calls.filter((call) => call.op === 'put')

describe('object_store keys', () => {
  it('keeps values, claims, and scopes under segments of their own, below the prefix', async () => {
    const client = memory_client()
    const store = object_store({ client, prefix: 'runs/' })
    await store.set('k', 1)
    await store.claim('k', 'owner', 60_000)
    await store.scope('a').set('k', 2)
    await store.scope('a').scope('b').claim('k', 'owner', 60_000)
    expect([...client.bucket.keys()].toSorted()).toEqual([
      'runs/c/k',
      'runs/s/a/s/b/c/k',
      'runs/s/a/v/k',
      'runs/v/k',
    ])
  })

  it('puts its keys at the top of the bucket when no prefix is given', async () => {
    const client = memory_client()
    await object_store({ client }).scope('a').set('k', 1)
    expect([...client.bucket.keys()]).toEqual(['s/a/v/k'])
  })

  it('percent-encodes every name, dots included', async () => {
    const client = memory_client()
    const store = object_store({ client })
    await store.set('a/b', 1)
    await store.set('..', 2)
    await store.scope('run 1/x.y').set('鍵', 3)
    expect([...client.bucket.keys()].toSorted()).toEqual([
      's/run%201%2Fx%2Ey/v/%E9%8D%B5',
      'v/%2E%2E',
      'v/a%2Fb',
    ])
  })

  it('keeps a name whose encoding is 128 characters as it is', async () => {
    const client = memory_client()
    await object_store({ client }).set('k'.repeat(128), 1)
    expect([...client.bucket.keys()]).toEqual([`v/${'k'.repeat(128)}`])
  })

  it('cuts a longer name to 64 characters and a hash of the whole name', async () => {
    const client = memory_client()
    const store = object_store({ client })
    const long = 'k'.repeat(129)
    await store.set(long, 1)
    await store.scope(long).claim(long, 'owner', 60_000)
    const hashed = `${'k'.repeat(64)}.${sha256(long)}`
    expect([...client.bucket.keys()].toSorted()).toEqual([`s/${hashed}/c/${hashed}`, `v/${hashed}`])
  })

  it('measures a name by its encoding, and keeps no percent sign in what it cuts', async () => {
    const client = memory_client()
    const store = object_store({ client })
    // 43 characters that encode to three apiece, which is 129.
    const name = '/'.repeat(43)
    await store.set(name, 1)
    const kept = '_2F'.repeat(21) + '_'
    expect([...client.bucket.keys()]).toEqual([`v/${kept}.${sha256(name)}`])
    expect(await store.get(name)).toBe(1)
  })

  it('keeps two long names apart when they differ only at the end', async () => {
    const store = object_store({ client: memory_client() })
    await store.set(`${'k'.repeat(300)}1`, 'one')
    await store.set(`${'k'.repeat(300)}2`, 'two')
    expect(await store.get(`${'k'.repeat(300)}1`)).toBe('one')
    expect(await store.get(`${'k'.repeat(300)}2`)).toBe('two')
  })
})

describe('object_store values', () => {
  it('writes a value as JSON with no condition, and a value JSON has no text for as null', async () => {
    const client = memory_client()
    const store = object_store({ client })
    await store.set('k', { v: 1 })
    await store.set('nothing', undefined)
    expect(puts_of(client)).toEqual([
      { op: 'put', key: 'v/k', body: '{"v":1}' },
      { op: 'put', key: 'v/nothing', body: 'null' },
    ])
    expect(await store.get('nothing')).toBeNull()
  })

  it('reads a missing object and a torn body as a miss', async () => {
    const client = memory_client()
    const store = object_store({ client })
    await client.put('v/torn', '{"torn')
    expect(await store.get('missing')).toBeNull()
    expect(await store.get('torn')).toBeNull()
  })

  it('deletes with no condition', async () => {
    const client = memory_client()
    const store = object_store({ client })
    await store.set('k', 1)
    await store.delete('k')
    expect(client.calls.at(-1)).toEqual({ op: 'delete', key: 'v/k' })
    expect(client.bucket.size).toBe(0)
  })

  it("reads a value with the object's ETag as its version", async () => {
    const client = memory_client()
    const store = object_store({ client })
    await store.set('k', { v: 1 })
    await store.set('null', null)
    await client.put('v/torn', '{"torn')
    expect(await store.get_versioned('k')).toStrictEqual({ value: { v: 1 }, version: 'etag-1' })
    expect(await store.get_versioned('null')).toStrictEqual({ value: undefined, version: 'etag-2' })
    expect(await store.get_versioned('torn')).toStrictEqual({ value: undefined, version: 'etag-3' })
    expect(await store.get_versioned('missing')).toBeUndefined()
  })

  it('keeps a falsy value apart from no value', async () => {
    const store = object_store({ client: memory_client() })
    await store.set('zero', 0)
    expect(await store.get_versioned('zero')).toMatchObject({ value: 0 })
  })

  it('creates with If-None-Match and replaces with If-Match on the version', async () => {
    const client = memory_client()
    const store = object_store({ client })
    expect(await store.set_if('k', { v: 1 }, null)).toBe(true)
    expect(await store.set_if('k', undefined, 'etag-1')).toBe(true)
    expect(puts_of(client)).toEqual([
      { op: 'put', key: 'v/k', body: '{"v":1}', condition: { if_none_match: '*' } },
      { op: 'put', key: 'v/k', body: 'null', condition: { if_match: 'etag-1' } },
    ])
  })

  it('reads the object again when a condition fails, and counts another body as a conflict', async () => {
    const client = memory_client()
    const store = object_store({ client })
    await store.set('k', { v: 1 })
    client.calls.length = 0
    expect(await store.set_if('k', { v: 2 }, null)).toBe(false)
    expect(await store.set_if('k', { v: 2 }, 'a stale etag')).toBe(false)
    expect(await store.set_if('gone', { v: 2 }, 'a stale etag')).toBe(false)
    expect(client.calls.map((call) => call.op)).toEqual(['put', 'get', 'put', 'get', 'put', 'get'])
    expect(await store.get('k')).toEqual({ v: 1 })
    expect(await store.get('gone')).toBeNull()
  })

  it('counts a failed condition as the write landing when the object holds the body it sent', async () => {
    const client = memory_client()
    const store = object_store({ client: losing_answers(client) })
    expect(await store.set_if('k', { v: 1 }, null)).toBe(true)
    expect(await store.set_if('k', { v: 2 }, 'etag-1')).toBe(true)
    expect(client.bucket.get('v/k')).toEqual({ body: '{"v":2}', etag: 'etag-2' })
  })

  it('surfaces a put that throws', async () => {
    const client = memory_client()
    const store = object_store({
      client: { ...client, put: () => Promise.reject(new Error('503 slow down')) },
    })
    await expect(store.set('k', 1)).rejects.toThrow('503 slow down')
    await expect(store.set_if('k', 1, null)).rejects.toThrow('503 slow down')
    await expect(store.claim('k', 'owner', 1_000)).rejects.toThrow('503 slow down')
  })
})

describe('object_store claims', () => {
  const claim_of = (client: MemoryClient, key: string): unknown =>
    JSON.parse(client.bucket.get(key)?.body ?? 'null')

  it('creates a free claim with If-None-Match, holding its owner and expiry', async () => {
    const client = memory_client()
    const store = object_store({ client })
    const before = Date.now()
    expect(await store.claim('k', 'owner', 5_000)).toBe(true)
    const claim = claim_of(client, 'c/k') as { owner: string; expires_at: number }
    expect(claim.owner).toBe('owner')
    expect(claim.expires_at).toBeGreaterThanOrEqual(before + 5_000)
    expect(claim.expires_at).toBeLessThanOrEqual(Date.now() + 5_000)
    expect(puts_of(client)).toMatchObject([{ key: 'c/k', condition: { if_none_match: '*' } }])
  })

  it('renews, and takes over an expired claim, with If-Match on the ETag it read', async () => {
    const client = memory_client()
    const store = object_store({ client })
    await store.claim('k', 'owner', 60_000)
    expect(await store.claim('k', 'owner', 60_000)).toBe(true)
    await client.put('c/k', JSON.stringify({ owner: 'owner', expires_at: Date.now() }))
    expect(await store.claim('k', 'next', 60_000)).toBe(true)
    expect(puts_of(client).map((call) => ('condition' in call ? call.condition : undefined))).toEqual([
      { if_none_match: '*' },
      { if_match: 'etag-1' },
      undefined,
      { if_match: 'etag-3' },
    ])
    expect(claim_of(client, 'c/k')).toMatchObject({ owner: 'next' })
  })

  it('refuses a live claim another owner holds without writing', async () => {
    const client = memory_client()
    const store = object_store({ client })
    await store.claim('k', 'owner', 60_000)
    client.calls.length = 0
    expect(await store.claim('k', 'another', 60_000)).toBe(false)
    expect(client.calls).toEqual([{ op: 'get', key: 'c/k' }])
  })

  it.each([
    ['is not JSON', '{"torn'],
    ['is not an object', '"owner"'],
    ['is null', 'null'],
    ['names no owner', '{"expires_at":99999999999999}'],
    ['names no expiry', '{"owner":"someone"}'],
  ])('takes a claim object whose body %s', async (_, body) => {
    const client = memory_client()
    const store = object_store({ client })
    await client.put('c/k', body)
    expect(await store.claim('k', 'owner', 60_000)).toBe(true)
    expect(claim_of(client, 'c/k')).toMatchObject({ owner: 'owner' })
  })

  it('loses a claim that changed between its read and its put', async () => {
    const client = memory_client()
    const racing: ObjectClient = {
      ...client,
      get: async (key) => {
        const read = await client.get(key)
        await client.put(key, JSON.stringify({ owner: 'faster', expires_at: Date.now() + 60_000 }))
        return read
      },
    }
    expect(await object_store({ client: racing }).claim('k', 'slower', 60_000)).toBe(false)
    expect(claim_of(client, 'c/k')).toMatchObject({ owner: 'faster' })
  })

  it('counts a claim as taken when its put landed and reported a failed condition', async () => {
    const client = memory_client()
    const store = object_store({ client: losing_answers(client) })
    expect(await store.claim('k', 'owner', 60_000)).toBe(true)
    expect(await store.claim('k', 'owner', 90_000)).toBe(true)
    expect(claim_of(client, 'c/k')).toMatchObject({ owner: 'owner' })
  })

  it('releases by overwriting the claim as expired, on its ETag, and never deletes', async () => {
    const client = memory_client()
    const store = object_store({ client })
    await store.claim('k', 'owner', 60_000)
    client.calls.length = 0
    await store.release('k', 'owner')
    expect(client.calls).toEqual([
      { op: 'get', key: 'c/k' },
      {
        op: 'put',
        key: 'c/k',
        body: '{"owner":"owner","expires_at":0}',
        condition: { if_match: 'etag-1' },
      },
    ])
    expect(await store.claim('k', 'next', 60_000)).toBe(true)
  })

  it('leaves the claim alone when another owner, or nobody, releases it', async () => {
    const client = memory_client()
    const store = object_store({ client })
    await store.release('k', 'owner')
    await store.claim('k', 'owner', 60_000)
    await store.release('k', 'another')
    expect(puts_of(client)).toHaveLength(1)
    expect(await store.claim('k', 'another', 60_000)).toBe(false)
  })

  it('resolves when the claim changed hands before the release landed', async () => {
    const client = memory_client()
    const racing: ObjectClient = {
      ...client,
      get: async (key) => {
        const read = await client.get(key)
        await client.put(key, JSON.stringify({ owner: 'next', expires_at: Date.now() + 60_000 }))
        return read
      },
    }
    await client.put('c/k', JSON.stringify({ owner: 'owner', expires_at: Date.now() + 60_000 }))
    await expect(object_store({ client: racing }).release('k', 'owner')).resolves.toBeUndefined()
    expect(claim_of(client, 'c/k')).toMatchObject({ owner: 'next' })
  })
})

describe('object_store scopes', () => {
  it('clears a scope a page at a time, and nothing beside it', async () => {
    const client = memory_client()
    const store = object_store({ client, prefix: 'runs/' })
    const a = store.scope('a')
    await store.set('k', 'root')
    await store.scope('a/b').set('k', 'beside')
    await Promise.all(['one', 'two', 'three', 'four'].map((key) => a.set(key, key)))
    await a.claim('lease', 'owner', 60_000)
    await a.scope('inner').set('k', 'inner')
    client.calls.length = 0
    await a.clear()
    expect([...client.bucket.keys()].toSorted()).toEqual(['runs/s/a%2Fb/v/k', 'runs/v/k'])
    // Six objects at three to a page: one page that names a next, and the rest.
    expect(client.calls.filter((call) => call.op === 'list')).toEqual([
      { op: 'list', prefix: 'runs/s/a/' },
      { op: 'list', prefix: 'runs/s/a/', start_after: 'runs/s/a/v/four' },
    ])
    expect(client.calls.filter((call) => call.op === 'delete')).toHaveLength(6)
  })

  it('keeps a cleared scope usable', async () => {
    const store = object_store({ client: memory_client() }).scope('a')
    await store.set('k', 1)
    await store.clear()
    expect(await store.set_if('k', 2, null)).toBe(true)
    expect(await store.get('k')).toBe(2)
  })
})
