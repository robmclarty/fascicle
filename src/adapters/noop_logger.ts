/**
 * No-op trajectory logger.
 *
 * Satisfies `TrajectoryLogger` from `core` without emitting any
 * output. A caller passes it where a logger is required and nothing should be
 * recorded, such as a test that does not care about trajectory output.
 * `run(...)` keeps its own private no-op for a run given no logger.
 */

import { randomUUID } from 'node:crypto'
import type { TrajectoryLogger } from '#core'

/**
 * Create a `TrajectoryLogger` whose methods do nothing.
 */
export function noop_logger(): TrajectoryLogger {
  return {
    record: () => {},
    start_span: (name) => `${name}:${randomUUID().slice(0, 8)}`,
    end_span: () => {},
  }
}
