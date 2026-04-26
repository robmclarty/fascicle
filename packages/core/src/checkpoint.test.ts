import { describe, expect, it, vi } from 'vitest';
import { checkpoint } from './checkpoint.js';
import { run } from './runner.js';
import { step } from './step.js';
import type { CheckpointStore, TrajectoryEvent, TrajectoryLogger } from './types.js';

function memory_store(): CheckpointStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key) {
      return data.has(key) ? data.get(key) : null;
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
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

describe('checkpoint', () => {
  it('returns cached value on hit and does not invoke inner (spec §10 test 13)', async () => {
    const spy = vi.fn((x: number) => x + 1);
    const inner = step('add_one', spy);
    const flow = checkpoint(inner, { key: 'k1' });
    const store = memory_store();
    store.data.set('k1', 42);

    const result = await run(flow, 5, {
      checkpoint_store: store,
      install_signal_handlers: false,
    });

    expect(result).toBe(42);
    expect(spy).not.toHaveBeenCalled();
  });

  it('runs inner and persists result on miss (spec §10 test 14)', async () => {
    const inner = step('add_one', (x: number) => x + 1);
    const flow = checkpoint(inner, { key: 'k2' });
    const store = memory_store();

    const result = await run(flow, 5, {
      checkpoint_store: store,
      install_signal_handlers: false,
    });

    expect(result).toBe(6);
    expect(store.data.get('k2')).toBe(6);
  });

  it('treats a corrupted read as a miss', async () => {
    const inner = step('add_one', (x: number) => x + 1);
    const flow = checkpoint(inner, { key: 'k3' });
    const store: CheckpointStore = {
      async get() {
        throw new Error('corrupted');
      },
      async set() {
        // noop
      },
      async delete() {
        // noop
      },
    };

    const result = await run(flow, 5, {
      checkpoint_store: store,
      install_signal_handlers: false,
    });
    expect(result).toBe(6);
  });

  it('throws synchronously when wrapping an anonymous step (F6)', () => {
    const anon = step((x: number) => x + 1);
    expect(() => checkpoint(anon, { key: 'k' })).toThrow(
      'checkpoint requires a named step; got anonymous',
    );
  });

  it('invokes the key function with the input to derive the key', async () => {
    const inner = step('build', (i: { spec_hash: string }) => i.spec_hash);
    const flow = checkpoint(inner, { key: (i: { spec_hash: string }) => `build:${i.spec_hash}` });
    const store = memory_store();

    await run(flow, { spec_hash: 'abc' }, {
      checkpoint_store: store,
      install_signal_handlers: false,
    });
    expect(store.data.has('build:abc')).toBe(true);
  });

  it('wraps inner execution in a checkpoint span', async () => {
    const { logger, events } = recording_logger();
    const flow = checkpoint(step('add_one', (x: number) => x + 1), { key: 'k4' });

    await run(flow, 1, { trajectory: logger, install_signal_handlers: false });
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'checkpoint');
    expect(start).toBeDefined();
    const end = events.find((e) => e.kind === 'span_end' && e['span_id'] === start?.['span_id']);
    expect(end).toBeDefined();
    expect(end?.['error']).toBeUndefined();
  });
});
