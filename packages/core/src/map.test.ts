import { afterEach, describe, expect, it } from 'vitest';
import { aborted_error } from './errors.js';
import { map } from './map.js';
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

describe('map', () => {
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l);
  });

  it('never exceeds concurrency and preserves order (spec §10 test 18)', async () => {
    let in_flight = 0;
    let peak = 0;

    const flow = map({
      items: (x: number[]) => x,
      concurrency: 2,
      do: step('item', async (v: number) => {
        in_flight += 1;
        if (in_flight > peak) peak = in_flight;
        await wait(20);
        in_flight -= 1;
        return v * 10;
      }),
    });

    const result = await run(flow, [1, 2, 3, 4, 5]);

    expect(result).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThanOrEqual(1);
  });

  it('runs with unbounded concurrency when omitted', async () => {
    const flow = map({
      items: (x: number[]) => x,
      do: step('item', async (v: number) => {
        await wait(10);
        return v + 1;
      }),
    });

    const started = Date.now();
    const result = await run(flow, [1, 2, 3, 4, 5, 6]);
    const elapsed = Date.now() - started;

    expect(result).toEqual([2, 3, 4, 5, 6, 7]);
    expect(elapsed).toBeLessThan(50);
  });

  it('emits a map span', async () => {
    const { logger, events } = recording_logger();
    const flow = map({
      items: (_x: number[]) => [1, 2],
      do: step('item', (v: number) => v),
    });

    await run(flow, [], { trajectory: logger, install_signal_handlers: false });

    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'map');
    expect(start).toBeDefined();
  });

  it('propagates abort to in-flight items and rethrows', async () => {
    let aborted_count = 0;
    let settled_count = 0;

    const flow = map({
      items: (_: number) => [1, 2, 3, 4],
      concurrency: 4,
      do: step('item', async (_v: number, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.abort.aborted) {
            aborted_count += 1;
            resolve();
            return;
          }
          ctx.abort.addEventListener(
            'abort',
            () => {
              aborted_count += 1;
              resolve();
            },
            { once: true },
          );
        });
        settled_count += 1;
        return 0;
      }),
    });

    const pending = run(flow, 0);
    await wait(20);
    process.emit('SIGINT');

    await expect(pending).rejects.toBeInstanceOf(aborted_error);
    expect(aborted_count).toBe(4);
    expect(settled_count).toBe(4);
  });

  it('handles empty item lists', async () => {
    const flow = map({
      items: (_x: number) => [],
      do: step('item', (v: number) => v),
    });
    await expect(run(flow, 0)).resolves.toEqual([]);
  });
});
