/**
 * retry: re-run on failure.
 *
 * `retry(inner, { max_attempts, backoff_ms?, on_error? })` runs `inner`. If it
 * throws, retries up to `max_attempts - 1` more times with exponential backoff
 * (`backoff_ms * 2^(attempt-1)`). `on_error` is called on every failure. The
 * last error is rethrown if all attempts fail.
 *
 * Cancellation / cleanup (constraints.md §5.2, spec.md §6.8): cleanup handlers
 * registered by the inner step accumulate across attempts. The parent
 * `ctx.abort` is honored between attempts — a pending abort short-circuits
 * the backoff and propagates. See spec.md §5.7 and §9 F11.
 */

import { aborted_error } from './errors.js';
import { dispatch_step, register_kind, resolve_span_label } from './runner.js';
import type { RunContext, Step } from './types.js';

const DEFAULT_BACKOFF_MS = 1_000;

export type RetryConfig = {
  readonly name?: string;
  readonly max_attempts: number;
  readonly backoff_ms?: number;
  readonly on_error?: (err: unknown, attempt: number) => void;
};

let retry_counter = 0;

function next_id(): string {
  retry_counter += 1;
  return `retry_${retry_counter}`;
}

async function abortable_wait(ms: number, ctx: RunContext): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    if (ctx.abort.aborted) {
      const reason = ctx.abort.reason;
      reject(reason instanceof Error ? reason : new aborted_error('aborted', { reason }));
      return;
    }
    const timer = setTimeout(() => {
      ctx.abort.removeEventListener('abort', on_abort);
      resolve();
    }, ms);
    const on_abort = (): void => {
      clearTimeout(timer);
      const reason = ctx.abort.reason;
      reject(reason instanceof Error ? reason : new aborted_error('aborted', { reason }));
    };
    ctx.abort.addEventListener('abort', on_abort, { once: true });
  });
}

export function retry<i, o>(inner: Step<i, o>, config: RetryConfig): Step<i, o> {
  const id = next_id();
  const max_attempts = Math.max(1, Math.floor(config.max_attempts));
  const backoff_ms = config.backoff_ms ?? DEFAULT_BACKOFF_MS;
  const on_error = config.on_error;

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    let last_err: unknown = undefined;
    for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
      if (ctx.abort.aborted) {
        const reason = ctx.abort.reason;
        throw reason instanceof Error ? reason : new aborted_error('aborted', { reason });
      }
      try {
        return await dispatch_step(inner, input, ctx);
      } catch (err) {
        last_err = err;
        if (on_error) on_error(err, attempt);
        if (attempt >= max_attempts) break;
        const delay = backoff_ms * 2 ** (attempt - 1);
        await abortable_wait(delay, ctx);
      }
    }
    throw last_err;
  };

  const config_meta: Record<string, unknown> = { max_attempts, backoff_ms };
  if (on_error) config_meta['on_error'] = on_error;
  if (config.name !== undefined) config_meta['display_name'] = config.name;

  return {
    id,
    kind: 'retry',
    children: [inner],
    config: config_meta,
    run: run_fn,
  };
}

register_kind('retry', async (flow, input, ctx) => {
  const label = resolve_span_label(flow, 'retry');
  const span_id = ctx.trajectory.start_span(label, { id: flow.id });
  try {
    const out = await flow.run(input, ctx);
    ctx.trajectory.end_span(span_id, { id: flow.id });
    return out;
  } catch (err) {
    ctx.trajectory.end_span(span_id, {
      id: flow.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
});
