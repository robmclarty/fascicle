/**
 * Bounded ring buffer of failure summaries.
 *
 * Reflexion's verbal-feedback memory, but capped: only the K most recent
 * lessons survive. Anything older is dropped. This is the load-bearing
 * defense against context bloat — if every failed candidate's full output
 * gets concatenated forever, the prompt grows linearly with iterations
 * and the model loses focus. K=5 is a starting point; raise on hard tasks.
 */

import type { Lesson } from './types.js'

export type LessonsBuffer = {
  append: (lesson: Lesson) => void
  list: () => ReadonlyArray<Lesson>
  format: () => string
  size: () => number
}

export function make_lessons(capacity: number): LessonsBuffer {
  if (capacity < 1) {
    throw new Error(`lessons: capacity must be >= 1, got ${String(capacity)}`)
  }
  const buf: Lesson[] = []

  return {
    append: (lesson: Lesson): void => {
      buf.push(lesson)
      if (buf.length > capacity) {
        buf.shift()
      }
    },
    list: (): ReadonlyArray<Lesson> => buf,
    size: (): number => buf.length,
    format: (): string => {
      if (buf.length === 0) return ''
      const items = buf.map(
        (l) =>
          `- round ${String(l.round)} (${l.proposer_id}, failed at ${l.stage_failed}): ${l.summary}`,
      )
      return ['Lessons from prior failed attempts (do not repeat):', ...items].join('\n')
    },
  }
}
