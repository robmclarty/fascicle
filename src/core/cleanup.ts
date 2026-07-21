/**
 * Per-run cleanup registry.
 *
 * Handlers fire in LIFO (reverse registration) order on abort, on uncaught
 * error in the root, and on successful completion. Each handler has a
 * 5-second timeout; timeouts are recorded in the trajectory but do not block
 * other handlers. A handler that throws is recorded as `cleanup_error`;
 * subsequent handlers still execute.
 */

import type { CleanupFn, TrajectoryLogger } from './types.js'

const HANDLER_TIMEOUT_MS = 5_000

export type CleanupRegistry = {
  readonly register: (fn: CleanupFn) => void
  readonly run_all: () => Promise<void>
}

/**
 * Create the per-run cleanup registry.
 *
 * `register` collects handlers during the run; `run_all` fires them once in
 * LIFO order and is idempotent. A registration arriving after the flush is
 * not executed; it is recorded as `cleanup_registered_after_flush` so the
 * leak is visible in the trajectory instead of silently dropped.
 */
export function create_cleanup_registry(trajectory: TrajectoryLogger): CleanupRegistry {
  const handlers: CleanupFn[] = []
  let ran = false

  function register(fn: CleanupFn): void {
    if (ran) {
      trajectory.record({
        kind: 'cleanup_registered_after_flush',
      })
      return
    }
    handlers.push(fn)
  }

  async function run_all(): Promise<void> {
    if (ran) return
    ran = true
    for (let i = handlers.length - 1; i >= 0; i -= 1) {
      const fn = handlers[i]
      if (!fn) continue
      await run_one(fn, trajectory)
    }
  }

  return { register, run_all }
}

/**
 * Run a single cleanup handler, never letting it fail the run.
 *
 * Races the handler against a 5-second timer. Whichever loses the race only
 * results in a trajectory record (`cleanup_timeout` or `cleanup_error`); the
 * returned promise always resolves so the remaining handlers still execute.
 * A timed-out handler keeps running in the background; it is abandoned, not
 * killed.
 */
async function run_one(fn: CleanupFn, trajectory: TrajectoryLogger): Promise<void> {
  let timeout_id: ReturnType<typeof setTimeout> | null = null
  try {
    await new Promise<void>((resolve) => {
      timeout_id = setTimeout(() => {
        trajectory.record({ kind: 'cleanup_timeout', timeout_ms: HANDLER_TIMEOUT_MS })
        resolve()
      }, HANDLER_TIMEOUT_MS)
    
      Promise.resolve()
        .then(() => fn())
        .then(
          () => {
            if (timeout_id) clearTimeout(timeout_id)
            resolve()
          },
          (err: unknown) => {
            if (timeout_id) clearTimeout(timeout_id)
            trajectory.record({
              kind: 'cleanup_error',
              error: err instanceof Error ? err.message : String(err),
            })
            resolve()
          },
        )
    })
  } finally {
    if (timeout_id) clearTimeout(timeout_id)
  }
}
