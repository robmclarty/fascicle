/**
 * No-op trajectory logger.
 *
 * Satisfies `TrajectoryLogger` from `@repo/core` without emitting any
 * output. Used as the default when no logger is supplied to `run(...)` and as
 * a cheap fallback in tests that do not care about trajectory output.
 */

import { randomUUID } from 'node:crypto';
import type { TrajectoryLogger } from '@repo/core';

export function noop_logger(): TrajectoryLogger {
  return {
    record: () => {},
    start_span: (name) => `${name}:${randomUUID().slice(0, 8)}`,
    end_span: () => {},
  };
}
