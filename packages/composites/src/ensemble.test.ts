import { aborted_error, run, step } from '@repo/core';
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ensemble } from './ensemble.js';

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

describe('ensemble (composite)', () => {
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l);
  });

  it('picks highest-score member as winner (spec §10 test 10)', async () => {
    const flow = ensemble({
      members: {
        a: step('a', () => ({ n: 3 })),
        b: step('b', () => ({ n: 7 })),
        c: step('c', () => ({ n: 5 })),
      },
      score: (r) => r.n,
    });

    const result = await run(flow, 'input', { install_signal_handlers: false });
    expect(result.winner).toEqual({ n: 7 });
    expect(result.scores).toEqual({ a: 3, b: 7, c: 5 });
  });

  it('picks lowest-score member when select is min', async () => {
    const flow = ensemble({
      members: {
        a: step('a', () => ({ n: 3 })),
        b: step('b', () => ({ n: 7 })),
        c: step('c', () => ({ n: 5 })),
      },
      score: (r) => r.n,
      select: 'min',
    });

    const result = await run(flow, 'input', { install_signal_handlers: false });
    expect(result.winner).toEqual({ n: 3 });
  });

  it('tie-breaks with any defined winner', async () => {
    const flow = ensemble({
      members: {
        a: step('a', () => ({ id: 'a' })),
        b: step('b', () => ({ id: 'b' })),
      },
      score: () => 1,
    });

    const result = await run(flow, 'input', { install_signal_handlers: false });
    expect(result.winner).toBeDefined();
    expect(['a', 'b']).toContain(result.winner.id);
  });

  it('propagates abort to in-flight members, awaits all, rethrows (criterion 26)', async () => {
    let a_aborted = false;
    let b_aborted = false;
    let a_settled = false;
    let b_settled = false;

    const flow = ensemble({
      members: {
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
          return { n: 1 };
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
          return { n: 2 };
        }),
      },
      score: (r) => r.n,
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

  it('wraps member execution in an "ensemble" span', async () => {
    const { logger, events } = recording_logger();
    const flow = ensemble({
      members: { a: step('a', () => ({ n: 1 })) },
      score: (r) => r.n,
    });

    await run(flow, 'input', { trajectory: logger, install_signal_handlers: false });
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'ensemble');
    expect(start).toBeDefined();
    const end = events.find((e) => e.kind === 'span_end' && e['span_id'] === start?.['span_id']);
    expect(end).toBeDefined();
    expect(end?.['error']).toBeUndefined();
  });

  it('honors a user-provided name override', async () => {
    const { logger, events } = recording_logger();
    const flow = ensemble({
      name: 'judge-pool',
      members: { a: step('a', () => ({ n: 1 })) },
      score: (r) => r.n,
    });

    await run(flow, 'input', { trajectory: logger, install_signal_handlers: false });
    const labels = events
      .filter((e) => e.kind === 'span_start')
      .map((e) => e['name'] as string);
    expect(labels).toContain('judge-pool');
    expect(labels).not.toContain('ensemble');
  });
});
