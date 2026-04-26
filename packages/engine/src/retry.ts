/**
 * Retry policy for provider-side failures.
 *
 * Narrow scope: retry only 429 rate limits, provider 5xx, and network errors.
 * Composition-layer retry wraps the whole generate call; this helper
 * transparently retries a single provider call between tool-loop turns.
 *
 * Invariants:
 *   - abort.aborted interrupts backoff waits and throws aborted_error.
 *   - Once a streaming response has delivered a chunk, the caller MUST NOT
 *     retry (spec §6.8). This helper is not wrapped around streaming calls
 *     past first chunk; the orchestrator enforces that boundary.
 *   - rate_limit respects Retry-After in both numeric seconds and HTTP-date
 *     forms.
 */

import type { RetryFailureKind, RetryPolicy } from './types.js';
import { aborted_error, provider_error, rate_limit_error } from './errors.js';

export const DEFAULT_RETRY: RetryPolicy = {
  max_attempts: 3,
  initial_delay_ms: 500,
  max_delay_ms: 30_000,
  retry_on: ['rate_limit', 'provider_5xx', 'network'],
};

export type RetryableError =
  | { kind: 'rate_limit'; retry_after_ms?: number; status?: number; message?: string }
  | { kind: 'provider_5xx'; status?: number; body?: string; message?: string }
  | { kind: 'network'; message?: string }
  | { kind: 'timeout'; message?: string };

export function parse_retry_after(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.floor(Number(trimmed) * 1000));
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, parsed - Date.now());
}

function compute_backoff(policy: RetryPolicy, attempt: number): number {
  const base = policy.initial_delay_ms * 2 ** attempt;
  const jitter = Math.random() * policy.initial_delay_ms;
  return Math.min(base + jitter, policy.max_delay_ms);
}

function wait_ms(ms: number, abort?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    if (abort?.aborted === true) {
      reject(new aborted_error('aborted', { reason: abort.reason }));
      return;
    }
    const timer = setTimeout(() => {
      if (abort !== undefined) abort.removeEventListener('abort', on_abort);
      resolve();
    }, ms);
    const on_abort = (): void => {
      clearTimeout(timer);
      reject(new aborted_error('aborted', { reason: abort?.reason }));
    };
    abort?.addEventListener('abort', on_abort, { once: true });
  });
}

function is_retryable(kind: RetryFailureKind, policy: RetryPolicy): boolean {
  return policy.retry_on.includes(kind);
}

/**
 * Retry `fn` under `policy`. `fn` must throw a RetryableError-shaped object to
 * trigger retry; any other thrown value short-circuits as a permanent failure.
 *
 * Returns the value from the last successful fn() call. On exhaustion, throws
 * rate_limit_error (for 429s) or provider_error (for 5xx/network/timeout).
 */
export async function retry_with_policy<t>(
  fn: (attempt: number) => Promise<t>,
  policy: RetryPolicy = DEFAULT_RETRY,
  abort?: AbortSignal,
): Promise<t> {
  let attempt = 0;
  let last_rate_limit_after: number | undefined;
  while (true) {
    if (abort?.aborted === true) {
      throw new aborted_error('aborted', { reason: abort.reason });
    }
    try {
      return await fn(attempt);
    } catch (err: unknown) {
      const retryable = classify_retryable(err);
      if (retryable === undefined) throw err;
      if (!is_retryable(retryable.kind, policy)) throw err;
      attempt += 1;
      if (attempt >= policy.max_attempts) {
        if (retryable.kind === 'rate_limit') {
          const metadata: { attempts: number; retry_after_ms?: number; status?: number } = {
            attempts: attempt,
          };
          if (retryable.retry_after_ms !== undefined) metadata.retry_after_ms = retryable.retry_after_ms;
          else if (last_rate_limit_after !== undefined) metadata.retry_after_ms = last_rate_limit_after;
          if (retryable.status !== undefined) metadata.status = retryable.status;
          throw new rate_limit_error(
            retryable.message ?? `rate limited after ${attempt} attempts`,
            metadata,
          );
        }
        const cause_kind =
          retryable.kind === 'provider_5xx' ? 'provider_5xx' : 'network';
        const metadata: { status?: number; body?: string; cause_kind: typeof cause_kind } = {
          cause_kind,
        };
        if (retryable.kind === 'provider_5xx') {
          if (retryable.status !== undefined) metadata.status = retryable.status;
          if (retryable.body !== undefined) metadata.body = retryable.body;
        }
        throw new provider_error(
          retryable.message ?? `${retryable.kind} after ${attempt} attempts`,
          metadata,
        );
      }

      let delay = compute_backoff(policy, attempt - 1);
      if (retryable.kind === 'rate_limit' && retryable.retry_after_ms !== undefined) {
        // When the server supplies Retry-After, honor it even if it exceeds
        // max_delay_ms; the server's instruction outranks the local backoff cap.
        delay = Math.max(delay, retryable.retry_after_ms);
        last_rate_limit_after = retryable.retry_after_ms;
      }
      await wait_ms(delay, abort);
    }
  }
}

function read_string(err: object, key: string): string | undefined {
  const value: unknown = Reflect.get(err, key);
  return typeof value === 'string' ? value : undefined;
}

function read_number(err: object, key: string): number | undefined {
  const value: unknown = Reflect.get(err, key);
  return typeof value === 'number' ? value : undefined;
}

function classify_retryable(err: unknown): RetryableError | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const kind = read_string(err, 'kind');
  if (kind === 'rate_limit') {
    const base: RetryableError = { kind: 'rate_limit' };
    const retry_after = read_number(err, 'retry_after_ms');
    if (retry_after !== undefined) base.retry_after_ms = retry_after;
    const status = read_number(err, 'status');
    if (status !== undefined) base.status = status;
    const message = read_string(err, 'message');
    if (message !== undefined) base.message = message;
    return base;
  }
  if (kind === 'provider_5xx') {
    const base: RetryableError = { kind: 'provider_5xx' };
    const status = read_number(err, 'status');
    if (status !== undefined) base.status = status;
    const body = read_string(err, 'body');
    if (body !== undefined) base.body = body;
    const message = read_string(err, 'message');
    if (message !== undefined) base.message = message;
    return base;
  }
  if (kind === 'network' || kind === 'timeout') {
    const base: RetryableError = { kind };
    const message = read_string(err, 'message');
    if (message !== undefined) base.message = message;
    return base;
  }
  return undefined;
}
