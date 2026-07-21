/**
 * retry: re-run on failure.
 *
 * `retry(inner, { max_attempts, backoff_ms?, on_error? })` runs `inner`. If it
 * throws an application error, retries up to `max_attempts - 1` more times with
 * exponential backoff (`backoff_ms * 2^(attempt-1)`). `on_error` is called on
 * every such failure. The last error is rethrown if all attempts fail.
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

const DEFAULT_BACKOFF_MS = 1_000

export type RetryConfig = {
  readonly name?: string
  readonly max_attempts: number
  readonly backoff_ms?: number
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
 * Sleep for `ms` unless the run is aborted first.
 *
 * Rejects immediately with the abort reason (or an `aborted_error`) when
 * `ctx.abort` fires, so a pending abort never waits out a backoff delay.
 */
async function abortable_wait(ms: number, ctx: RunContext): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    if (ctx.abort.aborted) {
      const reason = ctx.abort.reason
      reject(reason instanceof Error ? reason : new aborted_error('aborted', { reason }))
      return
    }
    const timer = setTimeout(() => {
      ctx.abort.removeEventListener('abort', on_abort)
      resolve()
    }, ms)
    const on_abort = (): void => {
      clearTimeout(timer)
      const reason = ctx.abort.reason
      reject(reason instanceof Error ? reason : new aborted_error('aborted', { reason }))
    }
    ctx.abort.addEventListener('abort', on_abort, { once: true })
  })
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
  const on_error = config.on_error

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    let last_err: unknown = undefined
    for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
      if (ctx.abort.aborted) {
        const reason = ctx.abort.reason
        throw reason instanceof Error ? reason : new aborted_error('aborted', { reason })
      }
      try {
        return await dispatch_step(inner, input, ctx)
      } catch (err) {
        if (is_control_flow_error(err)) throw err
        last_err = err
        if (on_error) on_error(err, attempt)
        if (attempt >= max_attempts) break
        const delay = backoff_ms * 2 ** (attempt - 1)
        await abortable_wait(delay, ctx)
      }
    }
    throw last_err
  }

  const config_meta: Record<string, unknown> = { max_attempts, backoff_ms }
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
