/**
 * Filesystem JSONL trajectory logger.
 *
 * Appends one JSON object per line to a configured output file. Span
 * bookkeeping (including the `parent_span_id` handling that keeps span trees
 * correct for concurrent children under `parallel`/`map`) lives in
 * `line_logger`. Two concurrent `run(...)` calls that pass distinct logger
 * instances (constructed with distinct `output_path`s) share nothing.
 *
 * Failure policy: an event that can't be serialized or appended is dropped
 * and reported, through the optional `on_error` callback or else as one line
 * on stderr. Never throws into the flow, the same as every adapter logger.
 *
 * Paths are accepted at construction; the logger never reads `process.env`.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { TrajectoryLogger } from '#core'
import { line_logger } from './line_logger.js'

export type FilesystemLoggerConfig = {
  readonly output_path: string
  /**
   * Called with the error when an event can't be serialized or appended.
   * Omitted, each failure writes one `filesystem_logger:` line to stderr.
   * Either way the event is dropped and the flow carries on.
   */
  readonly on_error?: (err: unknown) => void
}

/**
 * Create a `TrajectoryLogger` that appends one JSON object per line to
 * `output_path`, creating the parent directory if needed.
 */
export function filesystem_logger(config: FilesystemLoggerConfig): TrajectoryLogger {
  const { output_path } = config
  const report = config.on_error ?? ((err: unknown) => report_to_stderr(output_path, err))
  mkdirSync(dirname(output_path), { recursive: true })

  return line_logger((event) => {
    try {
      appendFileSync(output_path, `${JSON.stringify(event)}\n`)
    } catch (err: unknown) {
      try {
        report(err)
      } catch {
        // A reporter that throws is dropped too: the flow always wins.
      }
    }
  })
}

/**
 * The default reporter: one stderr line that names the file and the reason
 * an event was dropped.
 */
function report_to_stderr(output_path: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `filesystem_logger: dropped an event it could not write to ${output_path} (${reason}). Check that the path is a writable file and that every emitted value is JSON-serializable.\n`,
  )
}
