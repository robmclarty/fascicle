import { describe, expect, it, vi } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { CheckpointStore } from '#core'
import { checkpoint_session_store } from '../checkpoint_session_store.js'
import type { AcpStoredSession } from '../types.js'

/**
 * A checkpoint store in memory. With `versioned` it compares and sets, and
 * `before_set_if` runs ahead of each compare, for a test that plays another
 * writer getting in first.
 */
function memory_store(options: { versioned: boolean; before_set_if?: () => Promise<void> }) {
  const values = new Map<string, string>()
  const versions = new Map<string, number>()
  const write = (key: string, value: unknown): void => {
    values.set(key, JSON.stringify(value))
    versions.set(key, (versions.get(key) ?? 0) + 1)
  }
  const read = (key: string): unknown => {
    const text = values.get(key)
    return text === undefined ? null : JSON.parse(text)
  }
  const base: CheckpointStore = {
    get: async (key) => read(key),
    set: async (key, value) => write(key, value),
    delete: async (key) => {
      values.delete(key)
    },
  }
  const store: CheckpointStore = options.versioned
    ? {
        ...base,
        get_versioned: async (key) => (values.has(key) ? { value: read(key), version: String(versions.get(key)) } : undefined),
        set_if: async (key, value, expected) => {
          await options.before_set_if?.()
          const current = values.has(key) ? String(versions.get(key)) : null
          if (current !== expected) return false
          write(key, value)
          return true
        },
      }
    : base
  return { store, keys: () => [...values.keys()].toSorted(), write }
}

function stored(overrides: Partial<AcpStoredSession> = {}): AcpStoredSession {
  return {
    id: 'session-1',
    cwd: '/work',
    additional_directories: ['/lib'],
    mode: 'accept_edits',
    title: 'Fix the test',
    updated_at: '2026-10-31T12:00:00.000Z',
    history: [{ role: 'user', text: 'fix it' }],
    usage: { context_tokens: 1200, cost_usd: 0.02, priced: true },
    turns: 1,
    ...overrides,
  }
}

const turn: SessionUpdate[] = [
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fix it' } },
  { sessionUpdate: 'tool_call', toolCallId: 'card-1', title: 'Edit a.ts', status: 'completed' },
]

describe.each([{ versioned: true }, { versioned: false }])('checkpoint_session_store (versioned: $versioned)', ({ versioned }) => {
  it('keeps a session under its own key and lists it from the index', async () => {
    const { store, keys } = memory_store({ versioned })
    const sessions = checkpoint_session_store(store)
    expect(await sessions.list()).toEqual([])
    expect(await sessions.load('session-1')).toBeUndefined()
    await sessions.save(stored())
    expect(keys()).toEqual(['acp/session/session-1', 'acp/sessions'])
    expect(await sessions.load('session-1')).toEqual(stored())
    expect(await sessions.list()).toEqual([
      { id: 'session-1', cwd: '/work', additional_directories: ['/lib'], title: 'Fix the test', updated_at: '2026-10-31T12:00:00.000Z' },
    ])
  })

  it('puts the session saved last at the front of the index, once', async () => {
    const sessions = checkpoint_session_store(memory_store({ versioned }).store)
    await sessions.save(stored())
    await sessions.save(stored({ id: 'session-2', title: 'Another' }))
    await sessions.save(stored({ title: 'Renamed' }))
    expect((await sessions.list()).map((entry) => [entry.id, entry.title])).toEqual([
      ['session-1', 'Renamed'],
      ['session-2', 'Another'],
    ])
  })

  it('keeps each turn under a key of its own and loads the first count of them in order', async () => {
    const { store, keys } = memory_store({ versioned })
    const sessions = checkpoint_session_store(store)
    const second: SessionUpdate[] = [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }]
    await sessions.save_turn('session-1', 1, second)
    await sessions.save_turn('session-1', 0, turn)
    expect(keys()).toEqual(['acp/session/session-1/turn/0', 'acp/session/session-1/turn/1'])
    expect(await sessions.load_turns('session-1', 2)).toEqual([turn, second])
    expect(await sessions.load_turns('session-1', 1)).toEqual([turn])
    expect(await sessions.load_turns('session-1', 0)).toEqual([])
  })

  it('leaves out a turn that is missing or is not a list of updates', async () => {
    const { store, write } = memory_store({ versioned })
    const sessions = checkpoint_session_store(store)
    await sessions.save_turn('session-1', 0, turn)
    write('acp/session/session-1/turn/1', [{ not: 'an update' }])
    write('acp/session/session-1/turn/2', 'nope')
    expect(await sessions.load_turns('session-1', 4)).toEqual([turn])
  })

  it('deletes a session, its turns, and its index entry, and leaves the others', async () => {
    const { store, keys } = memory_store({ versioned })
    const sessions = checkpoint_session_store(store)
    await sessions.save_turn('session-1', 0, turn)
    await sessions.save_turn('session-1', 1, turn)
    await sessions.save(stored({ turns: 2 }))
    await sessions.save(stored({ id: 'session-2' }))
    await sessions.delete('session-1')
    expect(keys()).toEqual(['acp/session/session-2', 'acp/sessions'])
    expect(await sessions.load('session-1')).toBeUndefined()
    expect((await sessions.list()).map((entry) => entry.id)).toEqual(['session-2'])
  })

  it('resolves for a delete of a session it does not hold', async () => {
    const sessions = checkpoint_session_store(memory_store({ versioned }).store)
    await sessions.save(stored())
    await expect(sessions.delete('nope')).resolves.toBeUndefined()
    expect((await sessions.list()).map((entry) => entry.id)).toEqual(['session-1'])
  })

  it('fails a load of a value that is not a stored session, naming its key', async () => {
    const { store, write } = memory_store({ versioned })
    write('acp/session/broken', { id: 'broken' })
    await expect(checkpoint_session_store(store).load('broken')).rejects.toThrow(
      "the value at acp/session/broken isn't a stored ACP session; delete the session to list the others",
    )
  })

  it('lists the entries it can read from an index that holds something else too', async () => {
    const { store, write } = memory_store({ versioned })
    const sessions = checkpoint_session_store(store)
    await sessions.save(stored())
    const [entry] = await sessions.list()
    write('acp/sessions', [entry, { id: 'half' }, 'nope', { ...entry, id: 'bad-title', title: 3 }, { ...entry, id: 'bad-dirs', additional_directories: [1] }])
    expect((await sessions.list()).map((kept) => kept.id)).toEqual(['session-1'])
    write('acp/sessions', 'not a list')
    expect(await sessions.list()).toEqual([])
  })

  it('leaves out an index entry with any one field wrong, and keeps one whose title is null', async () => {
    const { store, write } = memory_store({ versioned })
    const sessions = checkpoint_session_store(store)
    await sessions.save(stored({ title: null }))
    const [entry] = await sessions.list()
    expect(entry).toEqual({ id: 'session-1', cwd: '/work', additional_directories: ['/lib'], title: null, updated_at: '2026-10-31T12:00:00.000Z' })
    write('acp/sessions', [
      null,
      { ...entry, id: 1 },
      { ...entry, id: 'no-cwd', cwd: 2 },
      { ...entry, id: 'no-dirs', additional_directories: '/lib' },
      { ...entry, id: 'no-title', title: undefined },
      { ...entry, id: 'no-date', updated_at: 3 },
      entry,
    ])
    expect(await sessions.list()).toEqual([entry])
    // A save reads the same index, so it keeps what a list shows and no more.
    await sessions.save(stored({ id: 'session-2' }))
    expect((await sessions.list()).map((kept) => kept.id)).toEqual(['session-2', 'session-1'])
  })

  it('lists a session once however often it is saved, and not at all once it is deleted', async () => {
    const { store, keys } = memory_store({ versioned })
    const sessions = checkpoint_session_store(store)
    for (const title of ['one', 'two', 'three']) await sessions.save(stored({ title }))
    await sessions.save(stored({ id: 'session-2' }))
    await sessions.save(stored({ title: 'four' }))
    expect((await sessions.list()).map((entry) => [entry.id, entry.title])).toEqual([
      ['session-1', 'four'],
      ['session-2', 'Fix the test'],
    ])
    await sessions.delete('session-1')
    await sessions.delete('session-1')
    expect((await sessions.list()).map((entry) => entry.id)).toEqual(['session-2'])
    await sessions.delete('session-2')
    expect(await sessions.list()).toEqual([])
    expect(keys()).toEqual(['acp/sessions'])
  })

  it('reads a store that answers undefined for a key it does not hold as holding no session', async () => {
    const { store } = memory_store({ versioned })
    const sessions = checkpoint_session_store({ ...store, get: async (key) => (await store.get(key)) ?? undefined })
    expect(await sessions.load('session-1')).toBeUndefined()
    expect(await sessions.list()).toEqual([])
    await expect(sessions.delete('session-1')).resolves.toBeUndefined()
  })
})

describe('checkpoint_session_store: two writers', () => {
  it("reads the index again when another writer got in first, so neither one's entry is lost", async () => {
    let raced = false
    const memory = memory_store({
      versioned: true,
      before_set_if: async () => {
        if (raced) return
        raced = true
        // Another agent process saves its own session between this one's read and its write.
        await checkpoint_session_store(memory.store).save(stored({ id: 'theirs', title: 'Theirs' }))
      },
    })
    await checkpoint_session_store(memory.store).save(stored({ id: 'ours', title: 'Ours' }))
    expect((await checkpoint_session_store(memory.store).list()).map((entry) => entry.id)).toEqual(['ours', 'theirs'])
  })

  it('gives up with an error that says what to do when every write loses', async () => {
    let writes = 0
    const memory = memory_store({
      versioned: true,
      before_set_if: async () => {
        writes += 1
        memory.write('acp/sessions', [])
      },
    })
    await expect(checkpoint_session_store(memory.store).save(stored())).rejects.toThrow(
      "couldn't update the session index at acp/sessions: 50 writes in a row lost to another writer; save the session again",
    )
    expect(writes).toBe(50)
  })

  it('creates the index only while nothing is there, so two first saves both land', async () => {
    const memory = memory_store({ versioned: true })
    await Promise.all([
      checkpoint_session_store(memory.store).save(stored({ id: 'a' })),
      checkpoint_session_store(memory.store).save(stored({ id: 'b' })),
    ])
    expect((await checkpoint_session_store(memory.store).list()).map((entry) => entry.id).toSorted()).toEqual(['a', 'b'])
  })

  it('makes one process\'s updates one after another on a store that cannot compare and set, so two saves both land', async () => {
    const memory = memory_store({ versioned: false })
    // A store that takes a moment to answer, as one over a network does.
    const slow: CheckpointStore = {
      ...memory.store,
      get: async (key) => {
        const value = await memory.store.get(key)
        await new Promise((resolve) => setTimeout(resolve, 5))
        return value
      },
    }
    const sessions = checkpoint_session_store(slow)
    await Promise.all([
      sessions.save(stored({ id: 'a' })),
      checkpoint_session_store(slow).save(stored({ id: 'b' })),
      sessions.save(stored({ id: 'c' })),
    ])
    expect((await sessions.list()).map((entry) => entry.id)).toEqual(['c', 'b', 'a'])
    await Promise.all([sessions.delete('a'), sessions.save(stored({ id: 'd' }))])
    expect((await sessions.list()).map((entry) => entry.id)).toEqual(['d', 'c', 'b'])
  })

  it.each(['get_versioned', 'set_if'] as const)('updates the index without comparing on a store that has %s alone', async (only) => {
    const memory = memory_store({ versioned: true })
    const { get, set, delete: remove, get_versioned, set_if } = memory.store
    const used = vi.fn()
    const half: CheckpointStore =
      only === 'get_versioned'
        ? {
            get,
            set,
            delete: remove,
            get_versioned: async (key) => {
              used()
              return get_versioned?.(key)
            },
          }
        : {
            get,
            set,
            delete: remove,
            set_if: async (key, value, expected) => {
              used()
              return (await set_if?.(key, value, expected)) ?? false
            },
          }
    const sessions = checkpoint_session_store(half)
    await sessions.save(stored({ id: 'a' }))
    await sessions.save(stored({ id: 'b' }))
    await sessions.delete('a')
    expect((await sessions.list()).map((entry) => entry.id)).toEqual(['b'])
    expect(used).not.toHaveBeenCalled()
  })

  it('fails the save whose index write failed, and goes on to the next update', async () => {
    const memory = memory_store({ versioned: false })
    let failed = false
    const flaky: CheckpointStore = {
      ...memory.store,
      set: async (key, value) => {
        if (key === 'acp/sessions' && !failed) {
          failed = true
          throw new Error('the store went away')
        }
        await memory.store.set(key, value)
      },
    }
    const sessions = checkpoint_session_store(flaky)
    const [first, second] = await Promise.allSettled([sessions.save(stored({ id: 'a' })), sessions.save(stored({ id: 'b' }))])
    expect(first).toMatchObject({ status: 'rejected', reason: new Error('the store went away') })
    expect(second).toMatchObject({ status: 'fulfilled' })
    expect((await sessions.list()).map((entry) => entry.id)).toEqual(['b'])
  })
})
