/**
 * tee_logger: fan one TrajectoryLogger contract out to many sinks.
 *
 * Each sink receives every record/start_span/end_span call. Sinks are called
 * in registration order and exceptions in one sink do not prevent the others
 * from receiving the event.
 *
 * The id from the first sink whose `start_span` returns is canonical and goes
 * back to the caller, or `<name>:tee` when every sink throws. The tee
 * remembers each sink's own id by its position, so that
 * `end_span(canonical_id, ...)` translates back to the right id for each sink,
 * and a sink that threw on `start_span` gets the canonical id. Within any one
 * sink the wire format stays internally consistent; only the across-sink ids
 * may differ.
 */

import type { TrajectoryLogger } from '#core'

/**
 * Create a `TrajectoryLogger` that fans every call out to `loggers`.
 */
export function tee_logger(...loggers: ReadonlyArray<TrajectoryLogger>): TrajectoryLogger {
  if (loggers.length === 0) {
    throw new Error(
      'tee_logger needs at least one logger: pass the sinks to fan out to, as in `tee_logger(stderr_logger(), http_logger(config))`',
    )
  }

  const id_map = new Map<string, ReadonlyArray<string | undefined>>()

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
      const ids: Array<string | undefined> = loggers.map(() => undefined)
      safe_each((l, idx) => {
        ids[idx] = l.start_span(name, meta)
      })
      const canonical = ids.find((sink_id) => sink_id !== undefined) ?? `${name}:tee`
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
