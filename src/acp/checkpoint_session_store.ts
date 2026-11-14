/**
 * checkpoint_session_store: ACP sessions kept in any `CheckpointStore`.
 *
 * An app that already has a checkpoint store for its durable runs, or one
 * of its own that passes the store conformance suite, keeps its sessions
 * there too, under three kinds of key. `acp/session/<id>` holds the session,
 * `acp/session/<id>/turn/<n>` holds turn `n` as the client saw it, and
 * `acp/sessions` holds the index that `session/list` reads, since a
 * `CheckpointStore` can't list its keys.
 *
 * Updating the index is a read, a change, and a write. On a store with
 * `get_versioned` and `set_if`, the write goes through only while the index
 * is still as it was read, and a writer that lost reads it again, so two
 * agent processes sharing a store never drop each other's entries. A store
 * without them is safe for one agent process at a time.
 *
 * A stored session holds the conversation, which can carry code or a key
 * the user pasted, so who can read it is up to the store underneath.
 */

import type { CheckpointStore } from '#core'
import { is_record } from '#schema'
import { is_stored_session, is_stored_turn, summary_of } from './session_store.js'
import type { AcpFullSessionStore, AcpSessionSummary } from './types.js'

/** The key of the index that `session/list` reads. */
const INDEX_KEY = 'acp/sessions'

/** How many times an index update reads again after losing its write to another writer. */
const INDEX_ATTEMPTS = 50

/**
 * The key a session is kept under.
 */
function session_key(id: string): string {
  return `acp/session/${id}`
}

/**
 * The key one turn of a session is kept under.
 */
function turn_key(id: string, index: number): string {
  return `${session_key(id)}/turn/${index}`
}

/**
 * Whether `value` is one entry of the index.
 */
function is_summary(value: unknown): value is AcpSessionSummary {
  if (!is_record(value)) return false
  const { id, cwd, additional_directories, title, updated_at } = value
  return (
    typeof id === 'string' &&
    typeof cwd === 'string' &&
    Array.isArray(additional_directories) &&
    additional_directories.every((entry) => typeof entry === 'string') &&
    (title === null || typeof title === 'string') &&
    typeof updated_at === 'string'
  )
}

/**
 * The index a store holds, read from whatever is under its key. Anything
 * that isn't an entry is left out, so one bad entry can't hide the rest.
 */
function index_of(value: unknown): AcpSessionSummary[] {
  return Array.isArray(value) ? value.filter(is_summary) : []
}

/**
 * Replace the index with `change` applied to it. On a store that can
 * compare and set, a write that lost to another writer reads the index
 * again and applies the change to what it finds.
 */
async function update_index(
  store: CheckpointStore,
  change: (index: AcpSessionSummary[]) => AcpSessionSummary[],
): Promise<void> {
  const { get_versioned, set_if } = store
  if (get_versioned === undefined || set_if === undefined) {
    await store.set(INDEX_KEY, change(index_of(await store.get(INDEX_KEY))))
    return
  }
  for (let attempt = 0; attempt < INDEX_ATTEMPTS; attempt += 1) {
    const read = await get_versioned(INDEX_KEY)
    if (await set_if(INDEX_KEY, change(index_of(read?.value)), read?.version ?? null)) return
  }
  throw new Error(
    `couldn't update the session index at ${INDEX_KEY}: ${INDEX_ATTEMPTS} writes in a row lost to another writer; save the session again`,
  )
}

/**
 * Build a session store that keeps its sessions in `store`, with their
 * turns, and can delete them.
 */
export function checkpoint_session_store(store: CheckpointStore): AcpFullSessionStore {
  return {
    save: async (session) => {
      await store.set(session_key(session.id), session)
      const summary = summary_of(session)
      await update_index(store, (index) => [summary, ...index.filter((entry) => entry.id !== session.id)])
    },
    load: async (id) => {
      const value = await store.get(session_key(id))
      if (value === undefined || value === null) return undefined
      if (is_stored_session(value)) return value
      throw new Error(`the value at ${session_key(id)} isn't a stored ACP session; delete the session to list the others`)
    },
    list: async () => index_of(await store.get(INDEX_KEY)),
    delete: async (id) => {
      const value = await store.get(session_key(id))
      const turns = is_stored_session(value) ? (value.turns ?? 0) : 0
      await Promise.all(Array.from({ length: turns }, (_, index) => store.delete(turn_key(id, index))))
      await store.delete(session_key(id))
      await update_index(store, (index) => index.filter((entry) => entry.id !== id))
    },
    save_turn: (id, index, updates) => store.set(turn_key(id, index), updates),
    load_turns: async (id, count) => {
      const turns = await Promise.all(Array.from({ length: count }, (_, index) => store.get(turn_key(id, index))))
      return turns.filter(is_stored_turn)
    },
  }
}
