/**
 * Line-oriented trajectory logger core.
 *
 * `filesystem_logger` and `stderr_logger` emit the same wire format (one JSON
 * object per line) and differ only in where the line goes. Both build on this:
 * `line_logger` adapts the shared span/record core (`trajectory_recorder`) to a
 * `write_line` sink, so the span bookkeeping and `parent_span_id` handling that
 * keep span trees correct under `parallel`/`map` live in exactly one place.
 */

import type { TrajectoryLogger } from '#core'
import { trajectory_recorder } from './trajectory_recorder.js'

/**
 * Create a `TrajectoryLogger` that writes one JSON object per line via
 * `write_line`.
 */
export function line_logger(write_line: (event: Record<string, unknown>) => void): TrajectoryLogger {
  return trajectory_recorder(write_line)
}
