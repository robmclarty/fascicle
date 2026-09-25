/**
 * retry: re-run on failure.
 *
 * `retry(inner, { max_attempts, backoff_ms?, max_delay_ms?, jitter?, when?, on_error?, project? })`
 * runs `inner`. If it throws an application error, retries up to
 * `max_attempts - 1` more times with exponential backoff
 * (`backoff_ms * 2^(attempt-1)`), jittered by up to one `backoff_ms` and
 * clamped to `max_delay_ms` (default 30s) through the shared `#policy`
 * algebra. `jitter` defaults on: un-jittered concurrent retries stampede in
 * lockstep. `when` decides which application errors are retryable: one it
 * rejects propagates at once, untouched, without consuming an attempt or
 * firing `on_error`. `on_error` is called on every retryable failure. The
 * last error is rethrown if all attempts fail.
 *
 * `project` maps the `{ value, attempts, errors }` envelope into the step's
 * output, so a caller can record how the value was reached without a
 * mutable closure or a trajectory read. Omitted, the value is the output.
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

/**
 * How a retry reached its value: `attempts` counts every dispatch including the
 * one that succeeded, and `errors` holds each failed attempt's error in order,
 * so `errors.length === attempts - 1`.
 */
export type RetryOutcome<o> = {
  readonly value: o
  readonly attempts: number
  readonly errors: ReadonlyArray<unknown>
}

export type RetryConfig = {
  readonly name?: string
  readonly max_attempts: number
  readonly backoff_ms?: number
  readonly max_delay_ms?: number
  readonly jitter?: boolean
  /**
   * Decide whether an application error is retryable. Returning false
   * propagates the error untouched, the way a control-flow signal does.
   * Omitted, every application error is retryable.
   */
  readonly when?: (err: unknown, attempt: number) => boolean
  readonly on_error?: (err: unknown, attempt: number) => void
}

/**
 * The `project` option `retry` accepts beside `RetryConfig`. It sits outside
 * `RetryConfig` so a config annotated as `RetryConfig` leaves the output type
 * to be inferred from the inner step.
 */
export type RetryProjection<o, projected> = {
  /**
   * Map the `RetryOutcome` envelope into the step's output inside the retry
   * step itself, so `describe` and the trajectory gain no wrapper node.
   * Omitted, the value is the output.
   */
  readonly project?: (outcome: RetryOutcome<o>) => projected
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

type Settled<o> = { readonly ok: true; readonly value: o } | { readonly ok: false; readonly error: unknown }

/**
 * Settle one attempt into a value or the error it threw, so the attempt loop
 * reads as a sequence of decisions instead of a nest of try/catch arms.
 */
async function settle<o>(attempt: Promise<o>): Promise<Settled<o>> {
  try {
    return { ok: true, value: await attempt }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Build a retrying step around `inner`.
 *
 * Runs `inner` up to `max_attempts` times with exponential backoff between
 * failures. Retryable application errors consume an attempt and fire
 * `on_error`; control-flow signals and errors `when` rejects propagate
 * untouched. `project` maps the outcome envelope into the output.
 */
export function retry<i, o, projected = o>(
  inner: Step<i, o>,
  config: RetryConfig & RetryProjection<o, projected>,
): Step<i, projected> {
  // A NaN or Infinity max_attempts would make the attempt loop never run (or
  // never end), so the misconfiguration fails at construction, not mid-run.
  if (!Number.isFinite(config.max_attempts)) {
    throw new TypeError(
      `retry: max_attempts must be a finite number, got ${config.max_attempts}`,
    )
  }
  const id = next_id()
  const max_attempts = Math.max(1, Math.floor(config.max_attempts))
  const backoff_ms = config.backoff_ms ?? DEFAULT_BACKOFF_MS
  const max_delay_ms = config.max_delay_ms ?? DEFAULT_MAX_DELAY_MS
  const jitter = config.jitter ?? true
  const when = config.when
  const on_error = config.on_error
  // When `project` is omitted, `projected` defaults to `o`, so handing back
  // the bare value is sound; the cast records that default.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const project = config.project ?? ((r: RetryOutcome<o>) => r.value as unknown as projected)
  const backoff_policy: BackoffPolicy = { initial_delay_ms: backoff_ms, max_delay_ms, jitter }

  const is_retryable = (err: unknown, attempt: number): boolean =>
    !is_control_flow_error(err) && (when === undefined || when(err, attempt))

  const run_fn = async (input: i, ctx: RunContext): Promise<projected> => {
    const errors: unknown[] = []
    for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
      if (ctx.abort.aborted) {
        throw to_abort_error(ctx.abort.reason)
      }
      const settled = await settle(dispatch_step(inner, input, ctx))
      // `project` runs outside the settled attempt, so an error it throws is
      // the caller's bug surfacing once rather than a failure that consumes
      // another attempt.
      if (settled.ok) return project({ value: settled.value, attempts: attempt, errors })
      if (!is_retryable(settled.error, attempt)) throw settled.error
      errors.push(settled.error)
      if (on_error) on_error(settled.error, attempt)
      if (attempt >= max_attempts) break
      const delay = compute_backoff(backoff_policy, attempt - 1)
      await wait_with_abort(delay, ctx.abort, to_abort_error)
    }
    // Stryker disable next-line all: the finiteness guard above forces max_attempts >= 1, so the loop always records an error before this throw; the ?? arm is unreachable belt and braces.
    throw errors.at(-1) ?? new Error('retry: no attempts executed')
  }

  const config_meta: Record<string, unknown> = { max_attempts, backoff_ms, max_delay_ms, jitter }
  if (when) config_meta['when'] = when
  if (on_error) config_meta['on_error'] = on_error
  if (config.project) config_meta['project'] = config.project
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
