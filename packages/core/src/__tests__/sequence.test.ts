import { describe, expect, it } from 'vitest';
import { run } from '../runner.js';
import { sequence } from '../sequence.js';
import { step } from '../step.js';
import type { TrajectoryEvent, TrajectoryLogger } from '../types.js';

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

describe('sequence', () => {
  it('chains three adders in declared order (spec §10 test 2)', async () => {
    const flow = sequence([
      step('add1', (x: number) => x + 1),
      step('add2', (x: number) => x + 2),
      step('add3', (x: number) => x + 3),
    ]);

    const result = await run(flow, 10);
    expect(result).toBe(16);
  });

  it('emits a sequence span wrapping children', async () => {
    const { logger, events } = recording_logger();
    const flow = sequence([
      step('a', (x: number) => x + 1),
      step('b', (x: number) => x * 2),
    ]);

    await run(flow, 1, { trajectory: logger, install_signal_handlers: false });

    const spans = events.filter((e) => e.kind === 'span_start').map((e) => e['name']);
    expect(spans[0]).toBe('sequence');
    expect(spans).toContain('step');
  });

  it('honors a user-supplied name as the span label (universal name? contract)', async () => {
    const { logger, events } = recording_logger();
    const flow = sequence(
      [step('a', (x: number) => x + 1), step('b', (x: number) => x * 2)],
      { name: 'my-flow' },
    );

    await run(flow, 1, { trajectory: logger, install_signal_handlers: false });

    const spans = events.filter((e) => e.kind === 'span_start').map((e) => e['name']);
    expect(spans[0]).toBe('my-flow');
  });

  it('records error on span end when a child throws', async () => {
    const { logger, events } = recording_logger();
    const flow = sequence([
      step('ok', (x: number) => x + 1),
      step('fail', () => {
        throw new Error('boom');
      }),
    ]);

    await expect(
      run(flow, 0, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toThrow('boom');

    const ends = events.filter((e) => e.kind === 'span_end');
    const seq_end = ends.find((e) => typeof e['error'] === 'string' && e['error'] === 'boom');
    expect(seq_end).toBeDefined();
  });
});
