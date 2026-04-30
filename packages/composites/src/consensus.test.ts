import { aborted_error, run, step } from '@repo/core';
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core';
import { afterEach, describe, expect, it } from 'vitest';
import { consensus } from './consensus.js';

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

describe('consensus (composite)', () => {
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l);
  });

  it('converges when members agree on round 2 (spec §10 test 12)', async () => {
    let round = 0;
    const flow = consensus({
      members: {
        a: step('a', () => {
          round += 1;
          return round > 2 ? 'same' : `diff_a_${round}`;
        }),
        b: step('b', () => (round > 2 ? 'same' : `diff_b_${round}`)),
      },
      agree: (r) => r['a'] === r['b'],
      max_rounds: 5,
    });

    const result = await run(flow, 'input', { install_signal_handlers: false });
    expect(result.converged).toBe(true);
    expect(result.result['a']).toEqual(result.result['b']);
  });

  it('returns last result with converged false when max_rounds reached', async () => {
    let n = 0;
    const flow = consensus({
      members: {
        a: step('a', () => {
          n += 1;
          return `a_${n}`;
        }),
        b: step('b', () => `b_${n}`),
      },
      agree: () => false,
      max_rounds: 2,
    });

    const result = await run(flow, 'input', { install_signal_handlers: false });
    expect(result.converged).toBe(false);
    expect(result.result['a']).toBeDefined();
    expect(result.result['b']).toBeDefined();
  });

  it('propagates abort to in-flight members (criterion 26)', async () => {
    const aborts: string[] = [];

    const flow = consensus({
      members: {
        a: step('a', async (_: number, ctx) => {
          await new Promise<void>((resolve) => {
            if (ctx.abort.aborted) {
              aborts.push('a');
              resolve();
              return;
            }
            ctx.abort.addEventListener(
              'abort',
              () => {
                aborts.push('a');
                resolve();
              },
              { once: true },
            );
          });
          return 1;
        }),
        b: step('b', async (_: number, ctx) => {
          await new Promise<void>((resolve) => {
            if (ctx.abort.aborted) {
              aborts.push('b');
              resolve();
              return;
            }
            ctx.abort.addEventListener(
              'abort',
              () => {
                aborts.push('b');
                resolve();
              },
              { once: true },
            );
          });
          return 2;
        }),
      },
      agree: (r) => r['a'] === r['b'],
      max_rounds: 3,
    });

    const pending = run(flow, 0);
    await wait(20);
    process.emit('SIGINT');

    await expect(pending).rejects.toBeInstanceOf(aborted_error);
    expect(aborts.toSorted()).toEqual(['a', 'b']);
  });

  it('wraps execution in a "consensus" span', async () => {
    const { logger, events } = recording_logger();
    const flow = consensus({
      members: {
        a: step('a', () => 'x'),
        b: step('b', () => 'x'),
      },
      agree: (r) => r['a'] === r['b'],
      max_rounds: 1,
    });

    await run(flow, 'input', { trajectory: logger, install_signal_handlers: false });
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'consensus');
    expect(start).toBeDefined();
    const end = events.find((e) => e.kind === 'span_end' && e['span_id'] === start?.['span_id']);
    expect(end).toBeDefined();
    expect(end?.['error']).toBeUndefined();
  });

  it('honors a user-provided name override', async () => {
    const { logger, events } = recording_logger();
    const flow = consensus({
      name: 'agreement-loop',
      members: {
        a: step('a', () => 'x'),
        b: step('b', () => 'x'),
      },
      agree: (r) => r['a'] === r['b'],
      max_rounds: 1,
    });

    await run(flow, 'input', { trajectory: logger, install_signal_handlers: false });
    const labels = events
      .filter((e) => e.kind === 'span_start')
      .map((e) => e['name'] as string);
    expect(labels).toContain('agreement-loop');
    expect(labels).not.toContain('consensus');
  });
});
