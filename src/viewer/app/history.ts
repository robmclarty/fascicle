/**
 * The full-history load that runs once before the app follows the live tail.
 *
 * `/api/trajectory` hands back the whole run as NDJSON: the tailed file when the
 * server has one, the ring buffer when it is ingest-fed (D7). Folding it here,
 * then resuming SSE past the returned cursor, is what makes opening a finished
 * `.jsonl` the same code path as watching a live run, and what keeps the two
 * transports from folding the same event twice.
 *
 * The cursor is the seam between history and live. It is the larger of the
 * broadcaster head the route stamped and the count of events actually folded:
 * the count leads when a file tail lagged its own file at dump time (the file
 * carried events the broadcaster had not), and the head leads when the ring had
 * evicted events the client could not receive (an ingest-fed run past the
 * buffer). Either way SSE resumes with no gap and no double-fold.
 *
 * Blank and undecodable lines are dropped exactly as the tail drops malformed
 * file lines, so the fold's count tracks the broadcaster's own event tally.
 * Nothing here touches the DOM or a wall clock: the caller stamps arrival time
 * and opens the stream, keeping this module a pure fold the node suite covers.
 */

import { EMPTY_SESSION, apply_frame, type Session } from './lib/scene.js'
import { parse_frame } from './sse.js'

/**
 * The header `/api/trajectory` stamps with the broadcaster's newest id. The
 * server owns the same literal (`viewer/server.ts`); the two ends cannot share
 * a module because the browser bundle must not pull in node builtins.
 */
export const CURSOR_HEADER = 'x-fascicle-cursor'

/** The folded history plus the cursor SSE resumes the live tail from. */
export type History = {
  readonly session: Session
  readonly count: number
  readonly cursor: number
}

/**
 * Fold an NDJSON history body into a session and report the SSE cursor.
 *
 * `head` is the broadcaster id the route stamped; the returned cursor is the
 * larger of it and the folded count, so a lagging file and an evicted ring both
 * resume on the correct seam.
 */
export function fold_history(body: string, head: number): History {
  let session = EMPTY_SESSION
  let count = 0
  for (const line of body.split('\n')) {
    if (line.length === 0) continue
    const frame = parse_frame(line)
    if (frame === null) continue
    session = apply_frame(session, frame)
    count += 1
  }
  return { session, count, cursor: Math.max(count, head) }
}

/**
 * Read the broadcaster head the route stamped on `CURSOR_HEADER`, 0 when the
 * header is absent or not a positive integer. Mirrors the server's own cursor
 * rule so a stray value degrades to "no cursor" rather than skipping the run.
 */
export function read_cursor_header(value: string | null): number {
  if (value === null) return 0
  const head = Number.parseInt(value, 10)
  return Number.isFinite(head) && head > 0 ? head : 0
}

/**
 * The `/api/events` url that resumes the live tail past `cursor`. A zero cursor
 * (nothing folded, empty history) opens the plain stream, so a first, empty
 * load is byte-identical to the pre-history contract.
 */
export function events_url(cursor: number): string {
  return cursor > 0 ? `/api/events?since=${cursor}` : '/api/events'
}
