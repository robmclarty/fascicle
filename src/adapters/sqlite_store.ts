/**
 * SQLite-backed checkpoint store.
 *
 * Satisfies `CheckpointStore` from `core`, every optional capability
 * included, on `node:sqlite`, which is built into Node and needs no native
 * module. One file holds every run, and several processes on one machine can
 * share it, since SQLite runs each statement atomically across connections.
 *
 * `node:sqlite` is loaded when `sqlite_store` is called and not before, so
 * importing `fascicle/adapters` never loads it, and never prints the warning
 * that an older Node 24 prints for an experimental module.
 *
 * Values and claims sit in a table each, keyed by scope and key. A scope is
 * a path of percent-encoded segments, each followed by `/`, so `clear`
 * deletes the range of paths that start with the scope's own and can't reach
 * a sibling whose name only looks alike. A value's version is drawn fresh on
 * every write, which is what `set_if` compares.
 *
 * A claim is one statement: an insert that updates on conflict only when the
 * current claim is the same owner's or has expired. The claimer has won when
 * the statement changed a row.
 *
 * The database opens in WAL mode with a busy timeout, so a second process
 * waits for a lock instead of failing at once.
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { CheckpointStore, Versioned } from '#core'

export type SqliteStoreConfig = {
  /** The database file, or `':memory:'` for one that lasts as long as the store. */
  readonly path: string
  /** How long a write waits on another connection's lock, in milliseconds; default: 5_000. */
  readonly timeout_ms?: number | undefined
}

/**
 * A scope of a `sqlite_store`, which can also `clear`.
 */
export type SqliteScopedStore = Required<Omit<CheckpointStore, 'scope'>> & {
  readonly scope: (prefix: string) => SqliteScopedStore
  readonly clear: () => Promise<void>
}

/**
 * What `sqlite_store` returns: a `CheckpointStore` with every optional
 * capability, which is what `durable` needs from its store, plus `close`.
 */
export type SqliteStore = Omit<SqliteScopedStore, 'clear'> & {
  /** Closes the database. The store can't be used afterwards. */
  readonly close: () => void
}

type Statements = {
  readonly get: StatementSync
  readonly put: StatementSync
  readonly remove: StatementSync
  readonly create: StatementSync
  readonly replace: StatementSync
  readonly claim: StatementSync
  readonly release: StatementSync
  readonly clear_values: StatementSync
  readonly clear_claims: StatementSync
}

const DEFAULT_TIMEOUT_MS = 5_000

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS fascicle_values (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    version TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS fascicle_claims (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (scope, key)
  ) WITHOUT ROWID;
`

/**
 * Open the database at `path` in WAL mode, with `timeout_ms` as its busy
 * timeout.
 */
function open(path: string, timeout_ms: number): DatabaseSync {
  const sqlite = process.getBuiltinModule('node:sqlite')
  const db = new sqlite.DatabaseSync(path)
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(timeout_ms))}`)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

/**
 * Prepare every statement the store runs.
 */
function prepare(db: DatabaseSync): Statements {
  return {
    get: db.prepare('SELECT value, version FROM fascicle_values WHERE scope = ? AND key = ?'),
    put: db.prepare(
      `INSERT INTO fascicle_values (scope, key, value, version) VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, version = excluded.version`,
    ),
    remove: db.prepare('DELETE FROM fascicle_values WHERE scope = ? AND key = ?'),
    create: db.prepare(
      `INSERT INTO fascicle_values (scope, key, value, version) VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, key) DO NOTHING`,
    ),
    replace: db.prepare(
      'UPDATE fascicle_values SET value = ?, version = ? WHERE scope = ? AND key = ? AND version = ?',
    ),
    claim: db.prepare(
      `INSERT INTO fascicle_claims (scope, key, owner, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (scope, key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
       WHERE fascicle_claims.owner = excluded.owner OR fascicle_claims.expires_at <= ?`,
    ),
    release: db.prepare('DELETE FROM fascicle_claims WHERE scope = ? AND key = ? AND owner = ?'),
    clear_values: db.prepare('DELETE FROM fascicle_values WHERE scope >= ? AND scope < ?'),
    clear_claims: db.prepare('DELETE FROM fascicle_claims WHERE scope >= ? AND scope < ?'),
  }
}

/**
 * Serialize a value for a row. A value JSON has no text for (`undefined`, a
 * bare function) is written as `null`, which reads back as a miss.
 */
function to_json(value: unknown): string {
  const text: string | undefined = JSON.stringify(value)
  return text ?? 'null'
}

/**
 * Parse a row's text, or `undefined` when it isn't JSON or holds `null`.
 */
function from_json(text: unknown): unknown {
  if (typeof text !== 'string') return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value === null ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * The path of the scope that `prefix` names under `parent`. Each segment is
 * percent-encoded, which leaves no `/` inside it, and ends in one.
 */
function child_path(parent: string, prefix: string): string {
  return `${parent}${encodeURIComponent(prefix)}/`
}

/**
 * The first path that sorts after every path starting with `path`. A scope's
 * path ends in `/`, and `0` is the character after it.
 */
function path_end(path: string): string {
  return `${path.slice(0, -1)}0`
}

/**
 * The store over the rows of one scope path.
 */
function store_at(db: DatabaseSync, sql: Statements, path: string): Omit<SqliteScopedStore, 'clear'> {
  return {
    get: async (key) => from_json(sql.get.get(path, key)?.['value']) ?? null,
    set: async (key, value) => {
      sql.put.run(path, key, to_json(value), randomUUID())
    },
    delete: async (key) => {
      sql.remove.run(path, key)
    },
    scope: (prefix) => {
      const inner = child_path(path, prefix)
      return {
        ...store_at(db, sql, inner),
        clear: async () => {
          db.exec('BEGIN IMMEDIATE')
          try {
            sql.clear_values.run(inner, path_end(inner))
            sql.clear_claims.run(inner, path_end(inner))
            db.exec('COMMIT')
          } catch (err) {
            db.exec('ROLLBACK')
            throw err
          }
        },
      }
    },
    claim: async (key, owner, ttl_ms) => {
      const at = Date.now()
      return sql.claim.run(path, key, owner, at + ttl_ms, at).changes === 1
    },
    release: async (key, owner) => {
      sql.release.run(path, key, owner)
    },
    get_versioned: async (key): Promise<Versioned | undefined> => {
      const row = sql.get.get(path, key)
      if (row === undefined) return undefined
      return { value: from_json(row['value']), version: String(row['version']) }
    },
    set_if: async (key, value, expected) => {
      const text = to_json(value)
      const version = randomUUID()
      const result =
        expected === null
          ? sql.create.run(path, key, text, version)
          : sql.replace.run(text, version, path, key, expected)
      return result.changes === 1
    },
  }
}

/**
 * Build a `CheckpointStore` over a SQLite database, with scopes, claims, and
 * conditional writes.
 *
 * The file is created when it doesn't exist, and so are the store's two
 * tables, which leaves room for other tables beside them. `close` closes the
 * database.
 */
export function sqlite_store(config: SqliteStoreConfig): SqliteStore {
  const db = open(config.path, config.timeout_ms ?? DEFAULT_TIMEOUT_MS)
  return {
    ...store_at(db, prepare(db), ''),
    close: () => {
      db.close()
    },
  }
}
