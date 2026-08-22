/**
 * Retry policy for provider-side failures.
 *
 * Narrow scope: retries 429 rate limits, provider 5xx errors, network
 * errors, and engine turn-timeout expiry (`turn_timeout_ms` throws a typed
 * timeout that the shared classifier treats as retryable). Composition-layer
 * retry wraps the whole generate call; this module retries a single provider
 * call between tool-loop turns.
 *
 * Once a streaming response has delivered a chunk, the caller must not retry
 * it: this helper is never wrapped around a streaming call past its first
 * chunk, and the orchestrator enforces that boundary.
 */

import type { RetryFailureKind, RetryPolicy } from './types.js'
import { aborted_error, provider_error, rate_limit_error } from './errors.js'
import { compute_backoff, wait_with_abort } from '#policy'
import type { BackoffPolicy } from '#policy'

export const DEFAULT_RETRY: RetryPolicy = {
  max_attempts: 3,
  initial_delay_ms: 500,
  max_delay_ms: 30_000,
  retry_on: ['rate_limit', 'provider_5xx', 'network', 'timeout'],
}

type RetryableError =
  | { kind: 'rate_limit'; retry_after_ms?: number; status?: number; message?: string }
  | { kind: 'provider_5xx'; status?: number; body?: string; message?: string }
  | { kind: 'network'; message?: string }
  | { kind: 'timeout'; message?: string }

/**
 * Parse an HTTP `Retry-After` header value into a millisecond delay.
 *
 * Accepts both forms the header allows: a plain integer or decimal number of
 * seconds, and an HTTP-date. Returns `undefined` for anything else (missing,
 * blank, or unparseable).
 */
export function parse_retry_after(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.floor(Number(trimmed) * 1000))
  }
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return undefined
  return Math.max(0, parsed - Date.now())
}

/**
 * Check whether `policy` allows retrying a failure of the given `kind`.
 */
function is_retryable(kind: RetryFailureKind, policy: RetryPolicy): boolean {
  return policy.retry_on.includes(kind)
}

/**
 * Map an abort reason onto the error this layer rejects with, always wrapping
 * so an abort can only ever surface as `aborted_error` with the caller's
 * reason attached.
 *
 * The engine's convention, and the opposite of core's propagate-verbatim rule.
 * Two things depend on the wrap. A bare `controller.abort()` sets
 * `signal.reason` to a `DOMException`, which is an `Error` on Node, so
 * propagating would leak a non-Fascicle error out of a boundary documented as
 * throwing `aborted_error`. And the engine's other abort sites (`generate`,
 * `tool_loop`, the adapters) wrap in order to attach `step_index` and
 * `tool_call_in_flight`, which only the construction site knows; propagating
 * would discard them. Wrapping a reason that is already an `aborted_error`
 * nests one inside the other, which is the accepted cost of that contract.
 */
function to_abort_error(reason: unknown): Error {
  return new aborted_error('aborted', { reason })
}

/**
 * Build the `rate_limit_error` thrown when 429 retries exhaust. Prefers the
 * failing attempt's own `Retry-After`, falling back to the most recent one a
 * prior attempt carried (`last_rate_limit_after`).
 */
function build_rate_limit_error(
  retryable: Extract<RetryableError, { kind: 'rate_limit' }>,
  attempt: number,
  last_rate_limit_after: number | undefined,
): rate_limit_error {
  const metadata: { attempts: number; retry_after_ms?: number; status?: number } = {
    attempts: attempt,
  }
  if (retryable.retry_after_ms !== undefined) metadata.retry_after_ms = retryable.retry_after_ms
  else if (last_rate_limit_after !== undefined) metadata.retry_after_ms = last_rate_limit_after
  if (retryable.status !== undefined) metadata.status = retryable.status
  return new rate_limit_error(
    retryable.message ?? `rate limited after ${attempt} attempts`,
    metadata,
  )
}

/**
 * Build the `provider_error` thrown when 5xx/network/timeout retries exhaust.
 * Timeout collapses onto the `network` cause; only 5xx carries status/body.
 */
function build_provider_error(
  retryable: Exclude<RetryableError, { kind: 'rate_limit' }>,
  attempt: number,
): provider_error {
  const cause_kind = retryable.kind === 'provider_5xx' ? 'provider_5xx' : 'network'
  const metadata: { status?: number; body?: string; cause_kind: typeof cause_kind } = {
    cause_kind,
  }
  if (retryable.kind === 'provider_5xx') {
    if (retryable.status !== undefined) metadata.status = retryable.status
    if (retryable.body !== undefined) metadata.body = retryable.body
  }
  return new provider_error(
    retryable.message ?? `${retryable.kind} after ${attempt} attempts`,
    metadata,
  )
}

/**
 * Map an exhausted retryable failure onto the error this layer rejects with:
 * `rate_limit_error` for 429s, `provider_error` for everything else.
 */
function build_exhaustion_error(
  retryable: RetryableError,
  attempt: number,
  last_rate_limit_after: number | undefined,
): Error {
  if (retryable.kind === 'rate_limit') {
    return build_rate_limit_error(retryable, attempt, last_rate_limit_after)
  }
  return build_provider_error(retryable, attempt)
}

/**
 * Compute the pre-retry backoff for `attempt`. A rate-limit `Retry-After`
 * outranks the local cap (`Math.max`), so a server instruction longer than
 * `max_delay_ms` is honored; the honored value is returned so the caller can
 * carry it onto a later failure that omits its own.
 */
function next_backoff(
  retryable: RetryableError,
  backoff_policy: BackoffPolicy,
  attempt: number,
): { delay: number; retry_after_ms?: number } {
  const delay = compute_backoff(backoff_policy, attempt - 1)
  if (retryable.kind === 'rate_limit' && retryable.retry_after_ms !== undefined) {
    return { delay: Math.max(delay, retryable.retry_after_ms), retry_after_ms: retryable.retry_after_ms }
  }
  return { delay }
}

/**
 * One failed-then-retried attempt, as reported through `on_retry`. `attempt`
 * is the 1-based count of failures so far, `delay_ms` the backoff this retry
 * will wait (a rate-limit `Retry-After` already folded in), and `status` /
 * `retry_after_ms` copy what the failure itself carried when it did.
 */
export type RetryAttemptInfo = {
  attempt: number
  failure_kind: RetryFailureKind
  delay_ms: number
  status?: number
  retry_after_ms?: number
}

/**
 * Assemble the `on_retry` payload from the classified failure and the backoff
 * the retry will actually wait.
 */
function build_attempt_info(
  retryable: RetryableError,
  attempt: number,
  delay_ms: number,
): RetryAttemptInfo {
  const info: RetryAttemptInfo = { attempt, failure_kind: retryable.kind, delay_ms }
  if (retryable.kind === 'rate_limit' || retryable.kind === 'provider_5xx') {
    if (retryable.status !== undefined) info.status = retryable.status
  }
  if (retryable.kind === 'rate_limit' && retryable.retry_after_ms !== undefined) {
    info.retry_after_ms = retryable.retry_after_ms
  }
  return info
}

/**
 * Retry `fn` under `policy`. `fn` must throw a RetryableError-shaped object to
 * trigger retry; any other thrown value short-circuits as a permanent failure.
 *
 * An aborted `abort` signal interrupts a pending backoff wait and throws
 * `aborted_error`. Returns the value from the last successful `fn()` call. On
 * exhaustion, throws `rate_limit_error` (for 429s) or `provider_error` (for
 * 5xx/network/timeout).
 *
 * `on_retry` fires once per retried failure, just before its backoff wait.
 * It does NOT fire for a first attempt that succeeds, a non-retryable
 * failure, or the final failure that exhausts the policy (those two throw
 * instead), so its call count is exactly the number of extra attempts made.
 */
export async function retry_with_policy<t>(
  fn: (attempt: number) => Promise<t>,
  policy: RetryPolicy = DEFAULT_RETRY,
  abort?: AbortSignal,
  on_retry?: (info: RetryAttemptInfo) => void,
): Promise<t> {
  const backoff_policy: BackoffPolicy = {
    initial_delay_ms: policy.initial_delay_ms,
    max_delay_ms: policy.max_delay_ms,
    jitter: true,
  }
  const signal = abort ?? new AbortController().signal
  let attempt = 0
  let last_rate_limit_after: number | undefined
  while (true) {
    if (abort?.aborted === true) {
      throw to_abort_error(abort.reason)
    }
    try {
      return await fn(attempt)
    } catch (err: unknown) {
      const retryable = classify_retryable(err)
      if (retryable === undefined || !is_retryable(retryable.kind, policy)) throw err
      attempt += 1
      if (attempt >= policy.max_attempts) {
        throw build_exhaustion_error(retryable, attempt, last_rate_limit_after)
      }
      const backoff = next_backoff(retryable, backoff_policy, attempt)
      last_rate_limit_after = backoff.retry_after_ms ?? last_rate_limit_after
      on_retry?.(build_attempt_info(retryable, attempt, backoff.delay))
      await wait_with_abort(backoff.delay, signal, to_abort_error)
    }
  }
}

/**
 * Read `key` off `err` and return it only if the value is a string.
 */
function read_string(err: object, key: string): string | undefined {
  const value: unknown = Reflect.get(err, key)
  return typeof value === 'string' ? value : undefined
}

/**
 * Read `key` off `err` and return it only if the value is a number.
 */
function read_number(err: object, key: string): number | undefined {
  const value: unknown = Reflect.get(err, key)
  return typeof value === 'number' ? value : undefined
}

/**
 * Assemble the `rate_limit` retryable shape, copying the optional
 * `retry_after_ms`, `status`, and `message` fields when each is present.
 */
function build_retryable_rate_limit(err: object): RetryableError {
  const base: RetryableError = { kind: 'rate_limit' }
  const retry_after = read_number(err, 'retry_after_ms')
  if (retry_after !== undefined) base.retry_after_ms = retry_after
  const status = read_number(err, 'status')
  if (status !== undefined) base.status = status
  const message = read_string(err, 'message')
  if (message !== undefined) base.message = message
  return base
}

/**
 * Assemble the `provider_5xx` retryable shape, copying the optional `status`,
 * `body`, and `message` fields when each is present.
 */
function build_retryable_5xx(err: object): RetryableError {
  const base: RetryableError = { kind: 'provider_5xx' }
  const status = read_number(err, 'status')
  if (status !== undefined) base.status = status
  const body = read_string(err, 'body')
  if (body !== undefined) base.body = body
  const message = read_string(err, 'message')
  if (message !== undefined) base.message = message
  return base
}

/**
 * Assemble a `network` or `timeout` retryable shape, copying the optional
 * `message` when present.
 */
function build_retryable_signal(err: object, kind: 'network' | 'timeout'): RetryableError {
  const base: RetryableError = { kind }
  const message = read_string(err, 'message')
  if (message !== undefined) base.message = message
  return base
}

/**
 * Classify a thrown value into a `RetryableError`, or `undefined` if it
 * does not carry one of the recognized retryable `kind`s.
 *
 * Providers throw plain objects tagged with `kind` (set by
 * `classify_provider_error` in generate.ts); this reads that shape back out
 * field by field rather than trusting it wholesale.
 */
function classify_retryable(err: unknown): RetryableError | undefined {
  if (err === null || typeof err !== 'object') return undefined
  const kind = read_string(err, 'kind')
  if (kind === 'rate_limit') return build_retryable_rate_limit(err)
  if (kind === 'provider_5xx') return build_retryable_5xx(err)
  if (kind === 'network' || kind === 'timeout') return build_retryable_signal(err, kind)
  return undefined
}
