/**
 * The backoff algebra shared by the composition layer and the engine.
 *
 * Both retry layers schedule delays between attempts, and each used to carry
 * its own exponential arithmetic plus its own timer/abort-listener dance. The
 * two drifted: one jittered and capped, the other did neither. This module is
 * the single algebra both express their delays through.
 *
 * The zone sits at the bottom of the dependency DAG and imports nothing, which
 * is why `wait_with_abort` is handed the abort-error factory rather than
 * constructing one: the error taxonomy lives in core, and reaching for it from
 * here would close a cycle back through the callers.
 */

export type BackoffPolicy = {
  readonly initial_delay_ms: number
  readonly max_delay_ms: number
  readonly jitter: boolean
}

/**
 * Map an abort reason onto the error a wait rejects with.
 *
 * Each layer surfaces an abort as its own error, so the caller supplies the
 * mapping instead of this zone owning an error taxonomy it cannot import.
 *
 * The two callers pass genuinely different factories, and that is settled, not
 * pending: core propagates an `Error` reason verbatim so an upstream cause
 * survives, while the engine always wraps so its boundary can only ever throw
 * `aborted_error`. Both were weighed once both layers rode this algebra; see
 * the factories in `core/retry.ts` and `engine/retry.ts` for what each protects.
 * Collapsing them to one rule breaks one layer or the other.
 */
export type AbortErrorFactory = (reason: unknown) => Error

/**
 * Compute the delay before retry attempt `attempt`, counted from zero.
 *
 * Exponential (`initial_delay_ms * 2^attempt`) plus up to one
 * `initial_delay_ms` of random jitter when `policy.jitter` is set, clamped to
 * `max_delay_ms`. The jitter spreads retries from concurrent callers apart so
 * they don't stampede in lockstep; a `max_delay_ms` of `Infinity` is uncapped.
 */
export function compute_backoff(policy: BackoffPolicy, attempt: number): number {
  const base = policy.initial_delay_ms * 2 ** attempt
  const jitter = policy.jitter ? Math.random() * policy.initial_delay_ms : 0
  return Math.min(base + jitter, policy.max_delay_ms)
}

/**
 * Sleep `ms`, rejecting the moment `signal` fires instead of serving out the
 * delay, so a pending abort never waits out a backoff.
 *
 * A non-positive `ms` resolves without arming a timer or consulting `signal`,
 * matching what both retry layers did before. The rejection value is
 * `to_error` applied to `signal.reason`.
 */
export function wait_with_abort(
  ms: number,
  signal: AbortSignal,
  to_error: AbortErrorFactory,
): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(to_error(signal.reason))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', on_abort)
      resolve()
    }, ms)
    const on_abort = (): void => {
      clearTimeout(timer)
      reject(to_error(signal.reason))
    }
    signal.addEventListener('abort', on_abort, { once: true })
  })
}
