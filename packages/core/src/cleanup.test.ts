import { describe, expect, it } from 'vitest';
import { create_cleanup_registry } from './cleanup.js';
import type { TrajectoryEvent, TrajectoryLogger } from './types.js';

function make_recording_logger(): { logger: TrajectoryLogger; events: TrajectoryEvent[] } {
  const events: TrajectoryEvent[] = [];
  const logger: TrajectoryLogger = {
    record: (event) => {
      events.push(event);
    },
    start_span: (name) => `span:${name}`,
    end_span: () => {},
  };
  return { logger, events };
}

describe('cleanup registry', () => {
  it('runs handlers in reverse registration order', async () => {
    const { logger } = make_recording_logger();
    const registry = create_cleanup_registry(logger);
    const order: string[] = [];

    registry.register(() => {
      order.push('A');
    });
    registry.register(() => {
      order.push('B');
    });
    registry.register(() => {
      order.push('C');
    });

    await registry.run_all();

    expect(order).toEqual(['C', 'B', 'A']);
  });

  it('records cleanup_error when a handler throws and continues with the rest', async () => {
    const { logger, events } = make_recording_logger();
    const registry = create_cleanup_registry(logger);
    let second_ran = false;

    registry.register(() => {
      second_ran = true;
    });
    registry.register(() => {
      throw new Error('boom');
    });

    await registry.run_all();

    expect(second_ran).toBe(true);
    const errs = events.filter((e) => e.kind === 'cleanup_error');
    expect(errs).toHaveLength(1);
    expect(errs[0]?.['error']).toContain('boom');
  });

  it('runs each handler at most once', async () => {
    const { logger } = make_recording_logger();
    const registry = create_cleanup_registry(logger);
    let n = 0;
    registry.register(() => {
      n += 1;
    });

    await registry.run_all();
    await registry.run_all();

    expect(n).toBe(1);
  });
});
