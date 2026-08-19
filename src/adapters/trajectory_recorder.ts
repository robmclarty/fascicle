/**
 * Shared span/record core for trajectory loggers.
 *
 * Every Fascicle trajectory logger emits the same wire format (one JSON object
 * per event) and differs only in where each event goes: `line_logger` writes a
 * line, `http_logger` POSTs NDJSON. This module holds the span bookkeeping they
 * share, parameterized by a single `emit` sink.
 *
 * `start_span` and `end_span` each emit one event; `record` emits the event as
 * written. When the caller supplies `parent_span_id` in the span meta (the
 * runner threads the true structural parent through `RunContext`), that value is
 * used verbatim, so span trees are correct even for concurrent children under
 * `parallel`/`map`. Only when no parent is supplied does the recorder fall back
 * to an in-memory stack of still-open spans, which is best-effort under
 * concurrency.
 */

import { randomUUID } from 'node:crypto'
import type { TrajectoryLogger } from '#core'

/**
 * Build a `TrajectoryLogger` whose events are handed, one at a time, to `emit`.
 */
export function trajectory_recorder(
  emit: (event: Record<string, unknown>) => void,
): TrajectoryLogger {
  const stack: string[] = []

  const start_span: TrajectoryLogger['start_span'] = (name, meta) => {
    const span_id = `${name}:${randomUUID().slice(0, 8)}`
    const event: Record<string, unknown> = { kind: 'span_start', span_id, name, ...meta }
    // Prefer the caller-threaded structural parent; fall back to the open-span
    // stack only when none was supplied (best-effort under concurrency).
    if (event['parent_span_id'] === undefined && stack.length > 0) {
      event['parent_span_id'] = stack[stack.length - 1]
    }
    emit(event)
    stack.push(span_id)
    return span_id
  }

  const end_span: TrajectoryLogger['end_span'] = (id, meta) => {
    emit({ kind: 'span_end', span_id: id, ...meta })
    const idx = stack.lastIndexOf(id)
    if (idx !== -1) stack.splice(idx, 1)
  }

  const record: TrajectoryLogger['record'] = (event) => {
    emit({ ...event })
  }

  return { record, start_span, end_span }
}
