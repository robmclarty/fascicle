/**
 * Filesystem JSONL trajectory logger.
 *
 * Appends one JSON object per line to a configured output file. `start_span`
 * and `end_span` each emit a line; `record` emits a line with the event as
 * written. When the caller supplies `parent_span_id` in the span meta (the
 * runner threads the true structural parent through `RunContext`), that value
 * is used verbatim, so span trees are correct even for concurrent children
 * under `parallel`/`map`. Only when no parent is supplied does the logger fall
 * back to an in-memory stack of still-open spans, which is best-effort under
 * concurrency. Two concurrent `run(...)` calls that pass distinct logger
 * instances (constructed with distinct `output_path`s) share nothing.
 *
 * Paths are accepted at construction; the logger never reads `process.env`.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TrajectoryLogger } from '#core'

export type FilesystemLoggerOptions = {
  readonly output_path: string
}

export function filesystem_logger(options: FilesystemLoggerOptions): TrajectoryLogger {
  const { output_path } = options
  mkdirSync(dirname(output_path), { recursive: true })

  const stack: string[] = []

  const write_line = (event: Record<string, unknown>): void => {
    appendFileSync(output_path, `${JSON.stringify(event)}\n`)
  }

  const start_span: TrajectoryLogger['start_span'] = (name, meta) => {
    const span_id = `${name}:${randomUUID().slice(0, 8)}`
    const event: Record<string, unknown> = { kind: 'span_start', span_id, name, ...meta }
    if (event['parent_span_id'] === undefined && stack.length > 0) {
      event['parent_span_id'] = stack[stack.length - 1]
    }
    write_line(event)
    stack.push(span_id)
    return span_id
  }

  const end_span: TrajectoryLogger['end_span'] = (id, meta) => {
    write_line({ kind: 'span_end', span_id: id, ...meta })
    const idx = stack.lastIndexOf(id)
    if (idx !== -1) stack.splice(idx, 1)
  }

  const record: TrajectoryLogger['record'] = (event) => {
    write_line({ ...event })
  }

  return { record, start_span, end_span }
}
