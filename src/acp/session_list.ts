/**
 * session_list: the page of stored sessions one `session/list` answers with.
 *
 * Sessions list newest first, 50 to a page. A cursor names the last session
 * of the page before it, by when it changed and its id, so a session saved
 * between two pages moves to the front without pushing one the client has
 * seen onto the next page. The protocol leaves a cursor opaque to the
 * client, and has an agent refuse one that isn't valid.
 */

import type { AcpSessionSummary } from './types.js'

/** The most sessions one `session/list` answers with. */
export const PAGE_SIZE = 50

/** One page of sessions, and the cursor for the page after it when more remain. */
export type SessionPage = {
  readonly sessions: ReadonlyArray<AcpSessionSummary>
  readonly next_cursor?: string | undefined
}

type Position = Pick<AcpSessionSummary, 'updated_at' | 'id'>

/**
 * Order two sessions newest first, and by id where two changed in the same
 * millisecond, so the order is the same every time it's asked for.
 */
function newest_first(a: Position, b: Position): number {
  return b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)
}

/**
 * The cursor that names `last` as the end of a page.
 */
function cursor_after(last: Position): string {
  return Buffer.from(JSON.stringify([last.updated_at, last.id]), 'utf8').toString('base64url')
}

/**
 * The session a cursor names, or undefined for a string that isn't one of
 * this agent's cursors.
 */
function cursor_position(cursor: string): Position | undefined {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const [updated_at, id]: unknown[] = value
  return typeof updated_at === 'string' && typeof id === 'string' ? { updated_at, id } : undefined
}

/**
 * The page of `summaries` that follows `cursor`, or the first page without
 * one, keeping only the sessions that started in `cwd` when it's given.
 * Returns undefined for a cursor that isn't valid.
 */
export function session_page(
  summaries: ReadonlyArray<AcpSessionSummary>,
  cwd: string | null | undefined,
  cursor: string | null | undefined,
): SessionPage | undefined {
  const listed = summaries.filter((summary) => cwd === undefined || cwd === null || summary.cwd === cwd).toSorted(newest_first)
  let rest = listed
  if (cursor !== undefined && cursor !== null) {
    const position = cursor_position(cursor)
    if (position === undefined) return undefined
    rest = listed.filter((summary) => newest_first(position, summary) < 0)
  }
  const sessions = rest.slice(0, PAGE_SIZE)
  const last = sessions.at(-1)
  return rest.length > PAGE_SIZE && last !== undefined ? { sessions, next_cursor: cursor_after(last) } : { sessions }
}
