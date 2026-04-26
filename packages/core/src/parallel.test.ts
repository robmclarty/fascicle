import { afterEach, describe, expect, it } from 'vitest';
import { aborted_error } from './errors.js';
import { parallel } from './parallel.js';
import { run } from './runner.js';
import { step } from './step.js';
import type { TrajectoryEvent, TrajectoryLogger } from './types.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

describe('parallel', () => {
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l);
  });

  it('runs two children concurrently (spec §10 test 3)', async () => {
    const flow = parallel({
      a: step('a', async (x: number) => {
        await wait(40);
        return x + 1;
      }),
      b: step('b', async (x: number) => {
        await wait(40);
        return x * 2;
      }),
    });

    const started = Date.now();
    const result = await run(flow, 3);
    const elapsed = Date.now() - started;

    expect(result).toEqual({ a: 4, b: 6 });
    expect(elapsed).toBeLessThan(80);
  });

  it('wraps children in a parallel span', async () => {
    const { logger, events } = recording_logger();
    const flow = parallel({
      a: step('a', (x: number) => x),
      b: step('b', (x: number) => x),
    });

    await run(flow, 1, { trajectory: logger, install_signal_handlers: false });

    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'parallel');
    expect(start).toBeDefined();
  });

  it('propagates abort to in-flight children, awaits all, rethrows (criterion 26)', async () => {
    let a_aborted = false;
    let b_aborted = false;
    let a_settled = false;
    let b_settled = false;

    const flow = parallel({
      a: step('a', async (_: number, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.abort.aborted) {
            a_aborted = true;
            resolve();
            return;
          }
          ctx.abort.addEventListener(
            'abort',
            () => {
              a_aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        a_settled = true;
        return 1;
      }),
      b: step('b', async (_: number, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.abort.aborted) {
            b_aborted = true;
            resolve();
            return;
          }
          ctx.abort.addEventListener(
            'abort',
            () => {
              b_aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        b_settled = true;
        return 2;
      }),
    });

    const pending = run(flow, 0);
    await wait(20);
    process.emit('SIGINT');

    await expect(pending).rejects.toBeInstanceOf(aborted_error);
    expect(a_aborted).toBe(true);
    expect(b_aborted).toBe(true);
    expect(a_settled).toBe(true);
    expect(b_settled).toBe(true);
  });
});
