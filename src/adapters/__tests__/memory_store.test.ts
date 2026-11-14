import { describe, expect, it } from 'vitest'
import { memory_store } from '../memory_store.js'

describe('memory_store', () => {
  it('hands back a copy, so changing what was stored or read changes nothing', async () => {
    const store = memory_store()
    const value = { list: [1] }
    await store.set('k', value)
    value.list.push(2)
    const read = await store.get('k')
    expect(read).toEqual({ list: [1] })
    ;(read as { list: number[] }).list.push(3)
    expect(await store.get('k')).toEqual({ list: [1] })
  })

  it('reads a missing key and a stored undefined as a miss', async () => {
    const store = memory_store()
    await store.set('k', undefined)
    expect(await store.get('k')).toBeNull()
    expect(await store.get('other')).toBeNull()
  })

  it('reaches the same data through the same prefix, and clears a whole subtree', async () => {
    const store = memory_store()
    await store.scope('a').set('k', 1)
    await store.scope('a').scope('b').set('k', 2)
    await store.scope('ab').set('k', 3)
    expect(await store.scope('a').get('k')).toBe(1)
    await store.scope('a').clear()
    expect(await store.scope('a').get('k')).toBeNull()
    expect(await store.scope('a').scope('b').get('k')).toBeNull()
    expect(await store.scope('ab').get('k')).toBe(3)
  })

  it('dumps every value by scope path and key, and leaves empty scopes out', async () => {
    const store = memory_store()
    await store.set('root', 1)
    await store.scope('a').scope('b').set('k', { nested: true })
    store.scope('empty')
    await store.scope('claimed').claim('lease', 'one', 1_000)
    expect(store.dump()).toEqual({
      '[]': { root: 1 },
      '["a","b"]': { k: { nested: true } },
    })
  })

  it('expires a claim against the clock it was given', async () => {
    let at = 1_000
    const store = memory_store({ now: () => at })
    expect(await store.claim('lease', 'one', 50)).toBe(true)
    at = 1_049
    expect(await store.claim('lease', 'two', 50)).toBe(false)
    at = 1_050
    expect(await store.claim('lease', 'two', 50)).toBe(true)
    await store.release('lease', 'one')
    expect(await store.claim('lease', 'one', 50)).toBe(false)
    await store.release('lease', 'two')
    expect(await store.claim('lease', 'one', 50)).toBe(true)
  })

  it('gives every write a version of its own, in any scope', async () => {
    const store = memory_store()
    await store.set('k', 'same')
    const first = await store.get_versioned('k')
    await store.set('k', 'same')
    const second = await store.get_versioned('k')
    await store.scope('a').set('k', 'same')
    const scoped = await store.scope('a').get_versioned('k')
    expect(new Set([first?.version, second?.version, scoped?.version]).size).toBe(3)
    expect(await store.set_if('k', 'next', first?.version ?? '')).toBe(false)
    expect(await store.set_if('k', 'next', second?.version ?? '')).toBe(true)
    expect(await store.get_versioned('missing')).toBeUndefined()
    expect(await store.set_if('missing', 1, null)).toBe(true)
    expect(await store.set_if('missing', 2, null)).toBe(false)
  })

  it('derives the version from the content when asked to', async () => {
    const store = memory_store({ content_versions: true })
    await store.set('k', { n: 1 })
    const first = await store.get_versioned('k')
    await store.set('k', { n: 1 })
    expect((await store.get_versioned('k'))?.version).toBe(first?.version)
    await store.set('k', { n: 2 })
    expect((await store.get_versioned('k'))?.version).not.toBe(first?.version)
  })

  it('reads a stored null with a version and no value', async () => {
    const store = memory_store()
    await store.set('k', null)
    const read = await store.get_versioned('k')
    expect(read?.value).toBeUndefined()
    expect(read?.version).toEqual(expect.any(String))
  })
})
