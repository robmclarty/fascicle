/**
 * A SQLite-backed `TaskStore` for the A2A SDK, on `node:sqlite`.
 *
 * Task records are what `GetTask` and `ListTasks` answer from, and
 * `ListTasks` filters by context, state, and time and pages with a cursor,
 * which is a query SQL answers without trying. The store keeps one row per
 * task in a table of its own, so it can share a file with `sqlite_store`
 * from `fascicle/adapters`, which keeps the runs behind the tasks. The two
 * can't share a transaction, so the runs stay the source of truth, and the
 * agent repairs a task record a crash left behind when it next loads it.
 *
 * Rows are scoped the way the SDK's `InMemoryTaskStore` scopes them: by the
 * request's tenant and by the caller's name, so one caller can't read or
 * list another's tasks. A page comes back newest first, by the time of each
 * task's status and then by id, and the cursor is the last row's pair.
 *
 * `node:sqlite` is loaded when the store is built, so importing
 * `fascicle/a2a` never loads it.
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { ListTasksRequest, ListTasksResponse, Task } from '@a2a-js/sdk'
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server'
import { from_plain, to_plain } from './parts.js'
import { load_a2a_server } from './sdk_loader.js'
import type { SqliteTaskStoreConfig } from './types.js'

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_PAGE_SIZE = 50

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS a2a_tasks (
    tenant TEXT NOT NULL,
    owner TEXT NOT NULL,
    id TEXT NOT NULL,
    context_id TEXT NOT NULL,
    state INTEGER NOT NULL,
    status_at TEXT NOT NULL,
    status_ms INTEGER,
    task TEXT NOT NULL,
    PRIMARY KEY (tenant, owner, id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS a2a_tasks_by_time ON a2a_tasks (tenant, owner, status_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS a2a_tasks_by_context ON a2a_tasks (tenant, owner, context_id);
`

type Scope = { readonly tenant: string; readonly owner: string }

type Cursor = { readonly status_at: string; readonly id: string }

type Filter = { readonly where: string; readonly values: SQLInputValue[] }

/**
 * Whose rows a call may touch: the request's tenant and the caller's name,
 * with every unauthenticated caller in one shared scope, as in the SDK's own
 * stores.
 */
function scope_of(context: ServerCallContext): Scope {
  const name = context.user?.userName
  return { tenant: context.tenant ?? '', owner: name === undefined || name === '' ? 'unknown' : name }
}

/**
 * Parse a stored row back into a task, or `undefined` for a row that holds
 * anything else.
 */
function task_of(row: Record<string, unknown> | undefined): Task | undefined {
  const text = row?.['task']
  if (typeof text !== 'string') return undefined
  // The store wrote this row from a Task, and `from_plain` gives its bytes back.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return from_plain(JSON.parse(text)) as Task
}

/**
 * The epoch milliseconds of an ISO timestamp, or `null` when it isn't one.
 */
function millis(timestamp: string | undefined): number | null {
  const at = timestamp === undefined ? Number.NaN : Date.parse(timestamp)
  return Number.isNaN(at) ? null : at
}

/**
 * Encode the last row of a page as the cursor for the next one.
 */
function encode_cursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.status_at}|${cursor.id}`).toString('base64')
}

/**
 * Read a page token back, or throw the SDK's `RequestMalformedError` for a
 * token this store didn't write.
 */
async function decode_cursor(token: string): Promise<Cursor> {
  const [status_at, ...rest] = Buffer.from(token, 'base64').toString('utf8').split('|')
  if (status_at === undefined || rest.length === 0) {
    const { errors } = await load_a2a_server()
    throw new errors.RequestMalformedError('Invalid page token format.')
  }
  return { status_at, id: rest.join('|') }
}

/**
 * The conditions a list request puts on the caller's rows, before paging.
 */
function filter_of(params: ListTasksRequest, scope: Scope): Filter {
  const where = ['tenant = ?', 'owner = ?']
  const values: SQLInputValue[] = [scope.tenant, scope.owner]
  if (params.contextId) {
    where.push('context_id = ?')
    values.push(params.contextId)
  }
  // 0 is TASK_STATE_UNSPECIFIED, which filters nothing.
  if (params.status) {
    where.push('state = ?')
    values.push(params.status)
  }
  const after = millis(params.statusTimestampAfter)
  if (after !== null) {
    where.push('status_ms > ?')
    values.push(after)
  }
  return { where: where.join(' AND '), values }
}

/**
 * Open the database at `path` in WAL mode with a busy timeout, and make the
 * task table when it isn't there.
 */
function open_tasks(config: SqliteTaskStoreConfig): DatabaseSync {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(config.path)
  const timeout_ms = config.timeout_ms ?? DEFAULT_TIMEOUT_MS
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(timeout_ms))}`)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

/**
 * Build a `TaskStore` over a SQLite database, for `a2a_agent`'s
 * `task_store`. It can share its file with a `sqlite_store`. `close` closes
 * the database.
 */
export function sqlite_task_store(config: SqliteTaskStoreConfig): TaskStore & { readonly close: () => void } {
  const db = open_tasks(config)
  const select = db.prepare('SELECT task FROM a2a_tasks WHERE tenant = ? AND owner = ? AND id = ?')
  const upsert = db.prepare(
    `INSERT INTO a2a_tasks (tenant, owner, id, context_id, state, status_at, status_ms, task)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant, owner, id) DO UPDATE SET
       context_id = excluded.context_id, state = excluded.state, status_at = excluded.status_at,
       status_ms = excluded.status_ms, task = excluded.task`,
  )

  return {
    load: async (task_id, context) => {
      const { tenant, owner } = scope_of(context)
      return task_of(select.get(tenant, owner, task_id))
    },
    save: async (task, context) => {
      const { tenant, owner } = scope_of(context)
      const timestamp = task.status?.timestamp
      upsert.run(
        tenant,
        owner,
        task.id,
        task.contextId,
        task.status?.state ?? 0,
        timestamp ?? '',
        millis(timestamp),
        JSON.stringify(to_plain(task)),
      )
    },
    list: async (params, context): Promise<ListTasksResponse> => {
      const page_size = params.pageSize ?? DEFAULT_PAGE_SIZE
      const filter = filter_of(params, scope_of(context))
      const total = db.prepare(`SELECT COUNT(*) AS n FROM a2a_tasks WHERE ${filter.where}`).get(...filter.values)
      const cursor = params.pageToken ? await decode_cursor(params.pageToken) : undefined
      const paged = cursor === undefined ? '' : ' AND (status_at, id) < (?, ?)'
      const rows = db
        .prepare(
          `SELECT status_at, id, task FROM a2a_tasks WHERE ${filter.where}${paged}
           ORDER BY status_at DESC, id DESC LIMIT ?`,
        )
        .all(...filter.values, ...(cursor === undefined ? [] : [cursor.status_at, cursor.id]), page_size + 1)
      const page = rows.slice(0, page_size)
      const last = page.at(-1)
      const tasks = page.flatMap((row) => {
        const task = task_of(row)
        if (task === undefined) return []
        return [params.includeArtifacts === true ? task : { ...task, artifacts: [] }]
      })
      return {
        tasks,
        nextPageToken:
          rows.length > page_size && last !== undefined
            ? encode_cursor({ status_at: String(last['status_at']), id: String(last['id']) })
            : '',
        pageSize: page_size,
        totalSize: Number(total?.['n'] ?? 0),
      }
    },
    close: () => {
      db.close()
    },
  }
}
