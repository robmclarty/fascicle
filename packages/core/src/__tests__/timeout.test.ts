import { describe, expect, it } from 'vitest';
import { aborted_error, timeout_error } from '../errors.js';
import { run } from '../runner.js';
import { step } from '../step.js';
import { timeout } from '../timeout.js';
import type { RunContext, TrajectoryEvent, TrajectoryLogger } from '../types.js';

function recording_logger(): { logger: TrajectoryLogger; events: TrajectoryEvent[] } {
  const events: TrajectoryEvent[] = [];
  let id = 0;
  const logger: TrajectoryLogger = {
    record: (event) => {
      events.push(event);
    },
    start_span: (name, meta) => {
      id += 1;
      const span_id = `span_${id}`;
      events.push({ kind: 'span_start', span_id, name, ...meta });
      return span_id;
    },
    end_span: (span_id, meta) => {
      events.push({ kind: 'span_end', span_id, ...meta });
    },
  };
  return { logger, events };
}

describe('timeout', () => {
  it('throws timeout_error when inner exceeds the budget (spec §10 test 7)', async () => {
    const slow = step('slow', async (_: number, ctx: RunContext) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 500);
        ctx.abort.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(ctx.abort.reason);
          },
          { once: true },
        );
      });
      return 'done';
    });

    const flow = timeout(slow, 50);
    const started = Date.now();
    await expect(run(flow, 0, { install_signal_handlers: false })).rejects.toBeInstanceOf(
      timeout_error,
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(200);
  });

  it('resolves normally when inner completes in time', async () => {
    const fast = step('fast', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'ok';
    });
    const flow = timeout(fast, 100);
    await expect(run(flow, 0, { install_signal_handlers: false })).resolves.toBe('ok');
  });

  it('inner step sees timeout_error as ctx.abort.reason (criterion 27)', async () => {
    let observed: unknown = undefined;

    const slow = step('slow', async (_: number, ctx: RunContext) => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 200);
        ctx.abort.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            observed = ctx.abort.reason;
            resolve();
          },
          { once: true },
        );
      });
      return 'done';
    });

    const flow = timeout(slow, 30);
    await expect(run(flow, 0, { install_signal_handlers: false })).rejects.toBeInstanceOf(
      timeout_error,
    );

    expect(observed).toBeInstanceOf(timeout_error);
    expect((observed as timeout_error).kind).toBe('timeout_error');
    expect((observed as timeout_error).timeout_ms).toBe(30);
  });

  it('inner step sees aborted_error as ctx.abort.reason when parent aborts', async () => {
    let observed: unknown = undefined;
    const slow = step('slow', async (_: number, ctx: RunContext) => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 500);
        ctx.abort.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            observed = ctx.abort.reason;
            resolve();
          },
          { once: true },
        );
      });
      return 'done';
    });

    const flow = timeout(slow, 10_000);
    const pending = run(flow, 0);
    await new Promise((resolve) => setTimeout(resolve, 15));
    process.emit('SIGINT');

    await expect(pending).rejects.toBeInstanceOf(aborted_error);
    expect(observed).toBeInstanceOf(aborted_error);
  });

  it('fires timeout_error on schedule even when inner ignores abort (F4)', async () => {
    let inner_still_running = false;
    const ignorant = step('ignorant', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      inner_still_running = true;
      return 'done';
    });

    const flow = timeout(ignorant, 100);
    const started = Date.now();
    await expect(run(flow, 0, { install_signal_handlers: false })).rejects.toBeInstanceOf(
      timeout_error,
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(250);
    expect(inner_still_running).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(inner_still_running).toBe(true);
  });

  it('wraps execution in a timeout span', async () => {
    const { logger, events } = recording_logger();
    const flow = timeout(step('ok', (x: number) => x), 100);

    await run(flow, 1, { trajectory: logger, install_signal_handlers: false });

    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'timeout');
    expect(start).toBeDefined();
    const end = events.find((e) => e.kind === 'span_end' && e['span_id'] === start?.['span_id']);
    expect(end).toBeDefined();
    expect(end?.['error']).toBeUndefined();
  });

  it('records timeout error on span_end when inner exceeds budget', async () => {
    const { logger, events } = recording_logger();
    const slow = step('slow', async (_: number, ctx: RunContext) => {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 500);
        ctx.abort.addEventListener('abort', () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
      return 'done';
    });
    const flow = timeout(slow, 30);

    await expect(
      run(flow, 0, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toBeInstanceOf(timeout_error);

    const timeout_end = events.find(
      (e) =>
        e.kind === 'span_end' &&
        typeof e['error'] === 'string' &&
        e['error'].includes('timeout after 30ms'),
    );
    expect(timeout_end).toBeDefined();
  });
});
