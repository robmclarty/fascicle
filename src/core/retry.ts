/**
 * retry: re-run on failure.
 *
 * `retry(inner, { max_attempts, backoff_ms?, max_delay_ms?, jitter?, on_error? })`
 * runs `inner`. If it throws an application error, retries up to
 * `max_attempts - 1` more times with exponential backoff
 * (`backoff_ms * 2^(attempt-1)`), jittered by up to one `backoff_ms` and
 * clamped to `max_delay_ms` (default 30s) through the shared `#policy`
 * algebra. `jitter` defaults on: un-jittered concurrent retries stampede in
 * lockstep. `on_error` is called on every such failure. The last error is
 * rethrown if all attempts fail.
 *
 * Control-flow signals (`suspended_error`, `aborted_error`) are not failures:
 * they propagate immediately without consuming an attempt, firing `on_error`,
 * or scheduling a backoff. A suspend's `on()` side effect therefore runs once
 * per run, not once per attempt.
 *
 * Cancellation / cleanup: cleanup handlers registered by the inner step
 * accumulate across attempts. The parent `ctx.abort` is honored between
 * attempts; a pending abort short-circuits the backoff and propagates.
 */

import { aborted_error, is_control_flow_error } from './errors.js'
import { dispatch_step, register_traced_kind } from './runner.js'
import type { RunContext, Step } from './types.js'
import { compute_backoff, wait_with_abort } from '#policy'
import type { BackoffPolicy } from '#policy'

const DEFAULT_BACKOFF_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 30_000

export type RetryConfig = {
  readonly name?: string
  readonly max_attempts: number
  readonly backoff_ms?: number
  readonly max_delay_ms?: number
  readonly jitter?: boolean
  readonly on_error?: (err: unknown, attempt: number) => void
}

let retry_counter = 0

/**
 * Generate a unique step id of the form `retry_<n>`.
 */
function next_id(): string {
  retry_counter += 1
  return `retry_${retry_counter}`
}

/**
 * Map an abort reason onto the error a retry rejects with, preserving an
 * `Error` reason verbatim rather than wrapping it in `aborted_error`.
 *
 * Core's convention, shared with `timeout`, `parallel`, `map`, the runner's
 * `throw_if_aborted`, and `bench`: this layer owns the signal chain, so the
 * cause set upstream has to survive it. Wrapping would turn `timeout`'s
 * `timeout_error` into an abort, and would flatten the runner's
 * `aborted_error('received SIGINT')` into a bare 'aborted' that
 * `runner.ts`'s catch cannot repair, since that repair only fires when the
 * escaping error is not already an `aborted_error`.
 *
 * The engine's retry deliberately does the opposite; `#policy`'s
 * `AbortErrorFactory` is where the two meet.
 */
function to_abort_error(reason: unknown): Error {
  return reason instanceof Error ? reason : new aborted_error('aborted', { reason })
}

/**
 * Build a retrying step around `inner`.
 *
 * Runs `inner` up to `max_attempts` times with exponential backoff between
 * failures. Application errors consume an attempt and fire `on_error`;
 * control-flow signals propagate untouched.
 */
export function retry<i, o>(inner: Step<i, o>, config: RetryConfig): Step<i, o> {
  const id = next_id()
  const max_attempts = Math.max(1, Math.floor(config.max_attempts))
  const backoff_ms = config.backoff_ms ?? DEFAULT_BACKOFF_MS
  const max_delay_ms = config.max_delay_ms ?? DEFAULT_MAX_DELAY_MS
  const jitter = config.jitter ?? true
  const on_error = config.on_error
  const backoff_policy: BackoffPolicy = { initial_delay_ms: backoff_ms, max_delay_ms, jitter }

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    let last_err: unknown = undefined
    for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
      if (ctx.abort.aborted) {
        throw to_abort_error(ctx.abort.reason)
      }
      try {
        return await dispatch_step(inner, input, ctx)
      } catch (err) {
        if (is_control_flow_error(err)) throw err
        last_err = err
        if (on_error) on_error(err, attempt)
        if (attempt >= max_attempts) break
        const delay = compute_backoff(backoff_policy, attempt - 1)
        await wait_with_abort(delay, ctx.abort, to_abort_error)
      }
    }
    throw last_err
  }

  const config_meta: Record<string, unknown> = { max_attempts, backoff_ms, max_delay_ms, jitter }
  if (on_error) config_meta['on_error'] = on_error
  if (config.name !== undefined) config_meta['display_name'] = config.name

  return {
    id,
    kind: 'retry',
    children: [inner],
    config: config_meta,
    run: run_fn,
  }
}

register_traced_kind('retry')
