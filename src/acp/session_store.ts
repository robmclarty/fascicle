/**
 * session_store: a filesystem store for ACP sessions, one JSON file each.
 *
 * A session is saved as `<id>.json` under the root directory. A save writes a
 * temporary sibling first and renames it into place, so a crash mid-write
 * leaves the earlier copy whole. A session holds the whole conversation,
 * which can carry code or a key the user pasted, so the directory the store
 * makes is readable by its owner alone, and so is every file it writes. A session id comes from the client on
 * `session/load` and `session/resume`, so only an id made of letters, digits,
 * `-`, and `_` names a file, and any other id reads as a session the store
 * doesn't hold rather than as a path. A file that isn't a stored session
 * fails its load with a message naming it, and `list` skips it with a
 * warning on stderr, so one bad file can't hide every other thread.
 *
 * Paths are accepted at construction; the store never reads `process.env`.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { is_acp_mode } from './modes.js'
import { error_code } from './tools/containment.js'
import type { AcpHistoryEntry, AcpSessionStore, AcpSessionSummary, AcpSessionUsage, AcpStoredSession } from './types.js'

export type FilesystemSessionStoreConfig = {
  /** The directory the session files go in, made on the first save. */
  readonly root_dir: string
}

/** The ids that can name a file, which every id the agent makes matches. */
const SAFE_ID = /^[\w-]+$/

/**
 * Whether `value` is a plain object, read as a record of unknown fields.
 */
function is_record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether `value` is a list of strings.
 */
function is_strings(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * Whether `value` is one history entry, with a role, its text, and, on the
 * entry where a cancelled turn stopped, the mark that says so.
 */
function is_history_entry(value: unknown): value is AcpHistoryEntry {
  if (!is_record(value)) return false
  const { role, text, cancelled } = value
  return (role === 'user' || role === 'agent') && typeof text === 'string' && (cancelled === undefined || cancelled === true)
}

/**
 * Whether `value` is a session's usage.
 */
function is_usage(value: unknown): value is AcpSessionUsage {
  if (!is_record(value)) return false
  const { context_tokens, cost_usd, priced } = value
  return typeof context_tokens === 'number' && typeof cost_usd === 'number' && typeof priced === 'boolean'
}

/**
 * Whether `value` is a stored session, checked field by field, since the
 * file is anything a person or another program left there.
 */
function is_stored_session(value: unknown): value is AcpStoredSession {
  if (!is_record(value)) return false
  const { id, cwd, additional_directories, mode, model, title, updated_at, history, usage } = value
  return (
    typeof id === 'string' &&
    typeof cwd === 'string' &&
    is_strings(additional_directories) &&
    is_acp_mode(mode) &&
    (model === undefined || typeof model === 'string') &&
    (title === null || typeof title === 'string') &&
    typeof updated_at === 'string' &&
    Array.isArray(history) &&
    history.every(is_history_entry) &&
    is_usage(usage)
  )
}

/**
 * Read the session file at `path`, or undefined when there is none. Throws
 * an `Error` naming the file when it holds anything but a stored session.
 */
async function read_session(path: string): Promise<AcpStoredSession | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err: unknown) {
    if (error_code(err) === 'ENOENT') return undefined
    throw err
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    value = undefined
  }
  if (is_stored_session(value)) return value
  throw new Error(`${path} isn't a stored ACP session; fix or delete the file to load the others`)
}

/**
 * Build a session store that keeps one JSON file for each session under
 * `root_dir`.
 */
export function filesystem_session_store(config: FilesystemSessionStoreConfig): AcpSessionStore {
  const path_of = (id: string): string => join(config.root_dir, `${id}.json`)
  return {
    save: async (session) => {
      if (!SAFE_ID.test(session.id)) {
        throw new Error(`can't save session ${JSON.stringify(session.id)}: an id names a file, so use letters, digits, - and _`)
      }
      await mkdir(config.root_dir, { recursive: true, mode: 0o700 })
      const temporary = join(config.root_dir, `.${session.id}.${randomUUID()}.tmp`)
      await writeFile(temporary, JSON.stringify(session), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path_of(session.id))
    },
    load: async (id) => (SAFE_ID.test(id) ? read_session(path_of(id)) : undefined),
    list: async () => {
      let names: string[]
      try {
        names = await readdir(config.root_dir)
      } catch (err: unknown) {
        if (error_code(err) === 'ENOENT') return []
        throw err
      }
      const files = names.filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      const sessions = await Promise.all(
        files.map((name) =>
          read_session(join(config.root_dir, name)).catch((err: unknown) => {
            process.stderr.write(`fascicle/acp: ${err instanceof Error ? err.message : String(err)}\n`)
            return undefined
          }),
        ),
      )
      return sessions
        .filter((session) => session !== undefined)
        .map(({ id, cwd, additional_directories, title, updated_at }): AcpSessionSummary => ({
          id,
          cwd,
          additional_directories,
          title,
          updated_at,
        }))
    },
  }
}
