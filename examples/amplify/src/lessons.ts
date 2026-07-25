/**
 * Bounded ring buffer of failure summaries.
 *
 * Reflexion's verbal-feedback memory, but capped: only the K most recent
 * lessons survive. Anything older is dropped. This is the load-bearing
 * defense against context bloat — if every failed candidate's full output
 * gets concatenated forever, the prompt grows linearly with iterations
 * and the model loses focus. K=5 is a starting point; raise on hard tasks.
 *
 * Pure functions over an immutable list, which rides inside the loop's
 * carry-state rather than in a mutable closure.
 */

import type { Lesson } from './types.js'

const LESSONS_CAPACITY = 5

/**
 * Append lessons, keeping only the most recent `capacity` entries.
 */
export function append_lessons(
  buffer: ReadonlyArray<Lesson>,
  incoming: ReadonlyArray<Lesson>,
  capacity: number = LESSONS_CAPACITY,
): ReadonlyArray<Lesson> {
  if (capacity < 1) {
    throw new Error(`lessons: capacity must be >= 1, got ${String(capacity)}`)
  }
  const next = [...buffer, ...incoming]
  return next.length <= capacity ? next : next.slice(next.length - capacity)
}

export function format_lessons(buffer: ReadonlyArray<Lesson>): string {
  if (buffer.length === 0) return ''
  const items = buffer.map(
    (l) => `- round ${String(l.round)} (${l.proposer_id}, failed at ${l.stage_failed}): ${l.summary}`,
  )
  return ['Lessons from prior failed attempts (do not repeat):', ...items].join('\n')
}
