import { afterEach, describe, expect, it } from 'vitest';
import { aborted_error } from '../errors.js';
import { run } from '../runner.js';
import { step } from '../step.js';

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('run()', () => {
  afterEach(() => {
    for (const listener of process.listeners('SIGINT')) {
      process.off('SIGINT', listener);
    }
    for (const listener of process.listeners('SIGTERM')) {
      process.off('SIGTERM', listener);
    }
  });

  it('resolves an atomic step to its output', async () => {
    await expect(run(step('id', (x: number) => x + 1), 1)).resolves.toBe(2);
  });

  it('throws on unknown step kinds', async () => {
    const bogus = {
      id: 'mystery',
      kind: 'not_registered',
      run: (x: number) => x,
    };
    await expect(run(bogus as never, 1)).rejects.toThrow(/unknown step kind/);
  });

  it('installs at most one SIGINT listener across sequential runs', async () => {
    const baseline = process.listenerCount('SIGINT');
    const s = step('noop', (x: number) => x);

    await run(s, 1);
    const after_first = process.listenerCount('SIGINT');
    await run(s, 1);
    const after_second = process.listenerCount('SIGINT');

    expect(after_first).toBeLessThanOrEqual(baseline + 1);
    expect(after_second).toBeLessThanOrEqual(baseline + 1);
  });

  it('respects install_signal_handlers: false and does not add listeners', async () => {
    const before = process.listenerCount('SIGINT');
    await run(step('noop', (x: number) => x), 0, { install_signal_handlers: false });
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('aborts an in-flight step on SIGINT and exposes aborted_error as the abort reason', async () => {
    let observed_reason: unknown = null;
    let cleanup_ran = false;

    const long_running = step('long', async (_: number, ctx) => {
      ctx.on_cleanup(() => {
        cleanup_ran = true;
      });
      await new Promise<void>((_resolve, reject) => {
        const t = setTimeout(() => {
          reject(new Error('did not abort in time'));
        }, 2_000);
        ctx.abort.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            observed_reason = ctx.abort.reason;
            reject(ctx.abort.reason instanceof Error ? ctx.abort.reason : new Error('aborted'));
          },
          { once: true },
        );
      });
      return 0;
    });

    const pending = run(long_running, 0);
    await wait(20);
    process.emit('SIGINT');

    await expect(pending).rejects.toBeInstanceOf(aborted_error);
    expect(cleanup_ran).toBe(true);
    expect(observed_reason).toBeInstanceOf(aborted_error);
  });
});
