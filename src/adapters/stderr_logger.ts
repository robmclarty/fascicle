/**
 * Stderr JSONL trajectory logger.
 *
 * Writes one JSON object per line to stderr (or an injected stream), leaving
 * stdout untouched. This is the blessed console logger for agents that run as
 * somebody's child process: under the stdio agent contract, stdout carries the
 * result envelope and belongs to the parent, so trajectory must go elsewhere.
 * The wire format is identical to `filesystem_logger`, so captured stderr is a
 * valid trajectory JSONL file (`2>events.jsonl`) the viewer parses unchanged.
 *
 * Writes never throw: a broken pipe or closed stream drops the event rather
 * than failing the flow.
 */

import type { TrajectoryLogger } from '#core'
import { line_logger } from './line_logger.js'

export type StderrLoggerOptions = {
  readonly stream?: { write(chunk: string): unknown }
}

/**
 * Create a `TrajectoryLogger` that writes one JSON object per line to
 * stderr, or to `options.stream` when supplied.
 */
export function stderr_logger(options: StderrLoggerOptions = {}): TrajectoryLogger {
  const stream = options.stream ?? process.stderr
  return line_logger((event) => {
    try {
      stream.write(`${JSON.stringify(event)}\n`)
    } catch {
      // Never throw from a logger; the flow always wins.
    }
  })
}
