import { describe, expect, it } from 'vitest';
import { aborted_error } from '../errors.js';
import { loop } from '../loop.js';
import { run } from '../runner.js';
import { step } from '../step.js';
import type { TrajectoryEvent, TrajectoryLogger } from '../types.js';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

describe('loop', () => {
  it('runs body to max_rounds when no guard is provided', async () => {
    const flow = loop<number, number, number>({
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      finish: (n) => n,
      max_rounds: 5,
    });

    const result = await run(flow, 0);
    expect(result.value).toBe(5);
    expect(result.converged).toBe(false);
    expect(result.rounds).toBe(5);
  });

  it('exits early when guard returns stop:true', async () => {
    const flow = loop<number, number, number>({
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      guard: step('check', (n: number) => ({ stop: n >= 3, state: n })),
      finish: (n) => n,
      max_rounds: 10,
    });

    const result = await run(flow, 0);
    expect(result.value).toBe(3);
    expect(result.converged).toBe(true);
    expect(result.rounds).toBe(3);
  });

  it('returns converged:false when guard never stops within max_rounds', async () => {
    const flow = loop<number, number, number>({
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      guard: step('check', (n: number) => ({ stop: n >= 100, state: n })),
      finish: (n) => n,
      max_rounds: 4,
    });

    const result = await run(flow, 0);
    expect(result.value).toBe(4);
    expect(result.converged).toBe(false);
    expect(result.rounds).toBe(4);
  });

  it('guard can transform state', async () => {
    const flow = loop<number, { n: number; tag: string }, string>({
      init: (n) => ({ n, tag: 'init' }),
      body: step('inc', (s: { n: number; tag: string }) => ({ n: s.n + 1, tag: s.tag })),
      guard: step('mark', (s: { n: number; tag: string }) => ({
        stop: s.n >= 2,
        state: { n: s.n, tag: 'guarded' },
      })),
      finish: (s) => `${s.tag}:${s.n}`,
      max_rounds: 5,
    });

    const result = await run(flow, 0);
    expect(result.value).toBe('guarded:2');
    expect(result.converged).toBe(true);
  });

  it('uses default span label "loop" when name is absent', async () => {
    const { logger, events } = recording_logger();
    const flow = loop<number, number, number>({
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      finish: (n) => n,
      max_rounds: 1,
    });

    await run(flow, 0, { trajectory: logger, install_signal_handlers: false });

    const spans = events.filter((e) => e.kind === 'span_start').map((e) => e['name']);
    expect(spans[0]).toBe('loop');
  });

  it('uses the user-provided name as span label when given', async () => {
    const { logger, events } = recording_logger();
    const flow = loop<number, number, number>({
      name: 'feedback-loop',
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      finish: (n) => n,
      max_rounds: 1,
    });

    await run(flow, 0, { trajectory: logger, install_signal_handlers: false });

    const spans = events.filter((e) => e.kind === 'span_start').map((e) => e['name']);
    expect(spans[0]).toBe('feedback-loop');
  });

  it('id is prefixed with name when provided', () => {
    const named = loop<number, number, number>({
      name: 'fb',
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      finish: (n) => n,
      max_rounds: 1,
    });
    expect(named.id.startsWith('fb_')).toBe(true);

    const anon = loop<number, number, number>({
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      finish: (n) => n,
      max_rounds: 1,
    });
    expect(anon.id.startsWith('loop_')).toBe(true);
  });

  it('clamps max_rounds to a minimum of 1', async () => {
    const flow = loop<number, number, number>({
      init: (n) => n,
      body: step('inc', (n: number) => n + 1),
      finish: (n) => n,
      max_rounds: 0,
    });

    const result = await run(flow, 0);
    expect(result.rounds).toBe(1);
    expect(result.value).toBe(1);
  });

  it('propagates abort between rounds (criterion: ctx.abort honored)', async () => {
    const flow = loop<number, number, number>({
      init: (n) => n,
      body: step('slow', async (n: number, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.abort.aborted) {
            resolve();
            return;
          }
          ctx.abort.addEventListener('abort', () => resolve(), { once: true });
        });
        return n + 1;
      }),
      finish: (n) => n,
      max_rounds: 50,
    });

    const pending = run(flow, 0);
    await wait(20);
    process.emit('SIGINT');

    await expect(pending).rejects.toBeInstanceOf(aborted_error);
  });

  it('exposes body and guard in children', () => {
    const body = step('inc', (n: number) => n + 1);
    const guard = step('check', (n: number) => ({ stop: false, state: n }));
    const flow = loop<number, number, number>({
      init: (n) => n,
      body,
      guard,
      finish: (n) => n,
      max_rounds: 1,
    });
    expect(flow.children).toEqual([body, guard]);
  });
});
