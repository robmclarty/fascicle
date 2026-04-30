import { describe, expect, it } from 'vitest';
import { compose } from './compose.js';
import { parallel } from './parallel.js';
import { run } from './runner.js';
import { sequence } from './sequence.js';
import { step } from './step.js';
import type { TrajectoryEvent, TrajectoryLogger } from './types.js';

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

describe('compose', () => {
  it('passes input through and returns inner output unchanged', async () => {
    const inner = sequence([
      step('add1', (n: number) => n + 1),
      step('double', (n: number) => n * 2),
    ]);
    const flow = compose('my-flow', inner);

    const result = await run(flow, 1);
    expect(result).toBe(4);
  });

  it('opens a span labeled with the user-supplied name', async () => {
    const { logger, events } = recording_logger();
    const flow = compose(
      'ensemble',
      sequence([
        step('a', (x: number) => x + 1),
        step('b', (x: number) => x * 2),
      ]),
    );

    await run(flow, 1, { trajectory: logger, install_signal_handlers: false });

    const span_starts = events.filter((e) => e.kind === 'span_start').map((e) => e['name']);
    expect(span_starts[0]).toBe('ensemble');
    expect(span_starts).toContain('sequence');
    expect(span_starts).toContain('step');
  });

  it('records error on span end when inner throws', async () => {
    const { logger, events } = recording_logger();
    const inner = step('boom', () => {
      throw new Error('inner failure');
    });
    const flow = compose('outer', inner);

    await expect(
      run(flow, undefined, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toThrow('inner failure');

    const ends = events.filter((e) => e.kind === 'span_end');
    const compose_end = ends.find(
      (e) => typeof e['error'] === 'string' && e['error'] === 'inner failure',
    );
    expect(compose_end).toBeDefined();
  });

  it('id starts with the user-supplied name', () => {
    const flow = compose('my-pattern', step('inner', (x: number) => x));
    expect(flow.id.startsWith('my-pattern_')).toBe(true);
  });

  it('exposes the inner step in children for describe()', () => {
    const inner = parallel({ a: step('a', (x: number) => x), b: step('b', (x: number) => x) });
    const flow = compose('ensemble', inner);
    expect(flow.children).toEqual([inner]);
    expect(flow.kind).toBe('compose');
  });

  it('rejects empty name at construction time', () => {
    expect(() => compose('', step('x', (n: number) => n))).toThrow(/non-empty string/);
  });

  it('preserves children spans nested inside the compose span', async () => {
    const { logger, events } = recording_logger();
    const flow = compose(
      'pattern',
      parallel({ left: step('l', (x: number) => x + 1), right: step('r', (x: number) => x - 1) }),
    );

    await run(flow, 10, { trajectory: logger, install_signal_handlers: false });

    const labels = events
      .filter((e) => e.kind === 'span_start')
      .map((e) => e['name'] as string);
    const compose_idx = labels.indexOf('pattern');
    const parallel_idx = labels.indexOf('parallel');
    expect(compose_idx).toBeGreaterThanOrEqual(0);
    expect(parallel_idx).toBeGreaterThan(compose_idx);
  });
});
