/**
 * tee_logger: fan one TrajectoryLogger contract out to many sinks.
 *
 * Each sink receives every record/start_span/end_span call. Sinks are called
 * in registration order and exceptions in one sink do not prevent the others
 * from receiving the event.
 *
 * The first sink's `start_span` return value is treated as canonical and
 * returned to the caller; the tee remembers each sink's per-sink id so that
 * `end_span(canonical_id, ...)` translates back to the right id for each sink.
 * Within any one sink the wire format stays internally consistent — only the
 * across-sink ids may differ.
 */

import type { TrajectoryLogger } from '@repo/core'

export function tee_logger(...loggers: ReadonlyArray<TrajectoryLogger>): TrajectoryLogger {
  if (loggers.length === 0) {
    throw new Error('tee_logger: at least one logger required')
  }

  const id_map = new Map<string, ReadonlyArray<string>>()

  const safe_each = (fn: (l: TrajectoryLogger, idx: number) => void): void => {
    for (let i = 0; i < loggers.length; i += 1) {
      const l = loggers[i]
      if (l === undefined) continue
      try {
        fn(l, i)
      } catch {
        // best-effort fan-out: a misbehaving sink must not derail the others
      }
    }
  }

  return {
    record: (event) => {
      safe_each((l) => l.record(event))
    },
    start_span: (name, meta) => {
      const ids: string[] = []
      safe_each((l) => {
        ids.push(l.start_span(name, meta))
      })
      const canonical = ids[0] ?? `${name}:tee`
      if (loggers.length > 1) id_map.set(canonical, ids)
      return canonical
    },
    end_span: (id, meta) => {
      const ids = id_map.get(id)
      if (ids === undefined) {
        safe_each((l) => l.end_span(id, meta))
        return
      }
      id_map.delete(id)
      safe_each((l, idx) => l.end_span(ids[idx] ?? id, meta))
    },
  }
}
