/**
 * Filesystem JSONL trajectory logger.
 *
 * Appends one JSON object per line to a configured output file. Span
 * bookkeeping (including the `parent_span_id` handling that keeps span trees
 * correct for concurrent children under `parallel`/`map`) lives in
 * `line_logger`. Two concurrent `run(...)` calls that pass distinct logger
 * instances (constructed with distinct `output_path`s) share nothing.
 *
 * Paths are accepted at construction; the logger never reads `process.env`.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TrajectoryLogger } from '#core'
import { line_logger } from './line_logger.js'

export type FilesystemLoggerOptions = {
  readonly output_path: string
}

/**
 * Create a `TrajectoryLogger` that appends one JSON object per line to
 * `output_path`, creating the parent directory if needed.
 */
export function filesystem_logger(options: FilesystemLoggerOptions): TrajectoryLogger {
  const { output_path } = options
  mkdirSync(dirname(output_path), { recursive: true })

  return line_logger((event) => {
    appendFileSync(output_path, `${JSON.stringify(event)}\n`)
  })
}
