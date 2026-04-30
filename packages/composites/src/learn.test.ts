import { aborted_error, run, step } from '@repo/core';
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core';
import { afterEach, describe, expect, it } from 'vitest';
import { learn, type LearnInput } from './learn.js';

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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const trivial_flow = step('trivial', (x: unknown) => x);

describe('learn (composite)', () => {
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l);
  });

  it('forwards LearnInput to the analyzer with flow_description, events, and prior', async () => {
    let captured: LearnInput | undefined;
    const events: ReadonlyArray<TrajectoryEvent> = [
      { kind: 'span_start', span_id: 's1', name: 'a', run_id: 'run-1' },
      { kind: 'span_end', span_id: 's1', run_id: 'run-1' },
    ];
    const flow = learn({
      flow: trivial_flow,
      source: { kind: 'events', events },
      analyzer: step('a', (input: LearnInput) => {
        captured = input;
        return { proposals: ['ok'] };
      }),
    });

    const result = await run(flow, 'my-prior', { install_signal_handlers: false });
    expect(captured).toBeDefined();
    expect(captured?.flow_description).toContain('trivial');
    expect(captured?.events).toHaveLength(2);
    expect(captured?.prior).toBe('my-prior');
    expect(result.proposals).toEqual({ proposals: ['ok'] });
    expect(result.events_considered).toBe(2);
    expect(result.run_ids).toEqual(['run-1']);
  });

  it('applies filter before passing events to the analyzer', async () => {
    let received_count = 0;
    const events: ReadonlyArray<TrajectoryEvent> = [
      { kind: 'a', run_id: 'r' },
      { kind: 'b', run_id: 'r' },
      { kind: 'a', run_id: 'r' },
    ];
    const flow = learn({
      flow: trivial_flow,
      source: { kind: 'events', events },
      filter: (e) => e.kind === 'a',
      analyzer: step('a', (input: LearnInput) => {
        received_count = input.events.length;
        return null;
      }),
    });

    const result = await run(flow, undefined, { install_signal_handlers: false });
    expect(received_count).toBe(2);
    expect(result.events_considered).toBe(2);
  });

  it('caps events at max_events', async () => {
    const events = Array.from(
      { length: 100 },
      (_, i): TrajectoryEvent => ({ kind: 'x', run_id: `r${String(i)}` }),
    );
    const flow = learn({
      flow: trivial_flow,
      source: { kind: 'events', events },
      max_events: 7,
      analyzer: step('a', (input: LearnInput) => input.events.length),
    });

    const result = await run(flow, undefined, { install_signal_handlers: false });
    expect(result.events_considered).toBe(7);
    expect(result.proposals).toBe(7);
  });

  it('deduplicates run_ids', async () => {
    const events: ReadonlyArray<TrajectoryEvent> = [
      { kind: 'x', run_id: 'a' },
      { kind: 'x', run_id: 'a' },
      { kind: 'x', run_id: 'b' },
      { kind: 'x' },
    ];
    const flow = learn({
      flow: trivial_flow,
      source: { kind: 'events', events },
      analyzer: step('a', () => 'done'),
    });

    const result = await run(flow, undefined, { install_signal_handlers: false });
    expect(result.run_ids).toEqual(['a', 'b']);
  });

  it('records a learn.summary trajectory event', async () => {
    const { logger, events: recorded } = recording_logger();
    const events: ReadonlyArray<TrajectoryEvent> = [
      { kind: 'span_start', run_id: 'a' },
      { kind: 'span_end', run_id: 'b' },
    ];
    const flow = learn({
      flow: trivial_flow,
      source: { kind: 'events', events },
      analyzer: step('a', () => 'done'),
    });

    await run(flow, undefined, { trajectory: logger, install_signal_handlers: false });
    const summary = recorded.find((e) => e.kind === 'learn.summary');
    expect(summary).toBeDefined();
    expect(summary?.['events_considered']).toBe(2);
    expect(summary?.['run_ids']).toEqual(['a', 'b']);
  });

  it('opens a "learn" span that wraps analyzer execution', async () => {
    const { logger, events: recorded } = recording_logger();
    const flow = learn({
      flow: trivial_flow,
      source: { kind: 'events', events: [] },
      analyzer: step('analyzer_x', () => 'done'),
    });

    await run(flow, undefined, { trajectory: logger, install_signal_handlers: false });

    const learn_open_idx = recorded.findIndex(
      (e) => e.kind === 'span_start' && e['name'] === 'learn',
    );
    expect(learn_open_idx).toBeGreaterThanOrEqual(0);
    const learn_span_id = recorded[learn_open_idx]?.['span_id'];
    const learn_close_idx = recorded.findIndex(
      (e) => e.kind === 'span_end' && e['span_id'] === learn_span_id,
    );
    const analyzer_open_idx = recorded.findIndex(
      (e) => e.kind === 'span_start' && e['id'] === 'analyzer_x',
    );
    expect(analyzer_open_idx).toBeGreaterThan(learn_open_idx);
    expect(analyzer_open_idx).toBeLessThan(learn_close_idx);
  });

  it('honors a user-provided name override', async () => {
    const { logger, events: recorded } = recording_logger();
    const flow = learn({
      name: 'distill_v1',
      flow: trivial_flow,
      source: { kind: 'events', events: [] },
      analyzer: step('a', () => 'done'),
    });

    await run(flow, undefined, { trajectory: logger, install_signal_handlers: false });
    const labels = recorded
      .filter((e) => e.kind === 'span_start')
      .map((e) => e['name'] as string);
    expect(labels).toContain('distill_v1');
    expect(labels).not.toContain('learn');
  });

  it('throws "not implemented" for "paths" and "dir" sources', async () => {
    const flow_paths = learn({
      flow: trivial_flow,
      source: { kind: 'paths', paths: ['/tmp/x.jsonl'] },
      analyzer: step('a', () => 'done'),
    });
    await expect(run(flow_paths, undefined, { install_signal_handlers: false })).rejects.toThrow(
      /not implemented/,
    );

    const flow_dir = learn({
      flow: trivial_flow,
      source: { kind: 'dir', dir: '/tmp/runs' },
      analyzer: step('a', () => 'done'),
    });
    await expect(run(flow_dir, undefined, { install_signal_handlers: false })).rejects.toThrow(
      /not implemented/,
    );
  });

  it('propagates abort during analyzer execution', async () => {
    const flow = learn({
      flow: trivial_flow,
      source: { kind: 'events', events: [] },
      analyzer: step('slow', async (_input: LearnInput, ctx) => {
        await new Promise<void>((_resolve, reject) => {
          if (ctx.abort.aborted) {
            reject(new Error('aborted'));
            return;
          }
          ctx.abort.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
        return 'done';
      }),
    });

    const pending = run(flow, undefined);
    await wait(20);
    process.emit('SIGINT');

    await expect(pending).rejects.toBeInstanceOf(aborted_error);
  });
});
