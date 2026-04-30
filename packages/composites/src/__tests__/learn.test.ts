import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aborted_error, run, step } from '@repo/core';
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core';
import { afterEach, describe, expect, it } from 'vitest';
import { learn, type LearnInput } from '../learn.js';

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

  it('reads "paths" source: parses JSONL files and forwards events to analyzer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'learn-paths-'));
    try {
      const events_a: TrajectoryEvent[] = [
        { kind: 'span_start', span_id: 's1', name: 'a', run_id: 'run-1' },
        { kind: 'custom', run_id: 'run-1', payload: 'first' },
      ];
      const events_b: TrajectoryEvent[] = [
        { kind: 'span_end', span_id: 's1', run_id: 'run-1' },
      ];
      const events_c: TrajectoryEvent[] = [
        { kind: 'custom', run_id: 'run-2', payload: 'second' },
        { kind: 'custom', run_id: 'run-2', payload: 'third' },
      ];
      const path_a = join(dir, 'a.jsonl');
      const path_b = join(dir, 'b.jsonl');
      const path_c = join(dir, 'c.jsonl');
      await writeFile(path_a, events_a.map((e) => JSON.stringify(e)).join('\n') + '\n');
      await writeFile(path_b, events_b.map((e) => JSON.stringify(e)).join('\n'));
      await writeFile(path_c, events_c.map((e) => JSON.stringify(e)).join('\n') + '\n\n');

      let captured: LearnInput | undefined;
      const flow = learn({
        flow: trivial_flow,
        source: { kind: 'paths', paths: [path_a, path_b, path_c] },
        analyzer: step('a', (input: LearnInput) => {
          captured = input;
          return 'ok';
        }),
      });

      const result = await run(flow, undefined, { install_signal_handlers: false });
      expect(captured?.events).toHaveLength(5);
      expect(captured?.events.map((e) => e.kind)).toEqual([
        'span_start',
        'custom',
        'span_end',
        'custom',
        'custom',
      ]);
      expect(result.events_considered).toBe(5);
      expect(result.run_ids).toEqual(['run-1', 'run-2']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads "dir" source: walks recursively, sorts paths, ignores non-jsonl', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'learn-dir-'));
    try {
      const nested = join(dir, 'nested');
      const deeper = join(nested, 'deeper');
      await mkdir(deeper, { recursive: true });

      const e_root: TrajectoryEvent = { kind: 'root', run_id: 'r-root' };
      const e_nested: TrajectoryEvent = { kind: 'nested', run_id: 'r-nested' };
      const e_deeper: TrajectoryEvent = { kind: 'deeper', run_id: 'r-deeper' };

      // sorted order across full paths: dir/a.jsonl, dir/nested/b.jsonl, dir/nested/deeper/c.jsonl
      await writeFile(join(dir, 'a.jsonl'), JSON.stringify(e_root) + '\n');
      await writeFile(join(nested, 'b.jsonl'), JSON.stringify(e_nested) + '\n');
      await writeFile(join(deeper, 'c.jsonl'), JSON.stringify(e_deeper) + '\n');

      // non-jsonl files at multiple levels
      await writeFile(join(dir, 'ignore.txt'), 'not jsonl');
      await writeFile(join(nested, 'also.json'), '{"kind":"json-not-jsonl"}');
      await writeFile(join(deeper, 'README.md'), '# nope');

      let captured: LearnInput | undefined;
      const flow = learn({
        flow: trivial_flow,
        source: { kind: 'dir', dir },
        analyzer: step('a', (input: LearnInput) => {
          captured = input;
          return 'ok';
        }),
      });

      const result = await run(flow, undefined, { install_signal_handlers: false });
      expect(captured?.events.map((e) => e.kind)).toEqual(['root', 'nested', 'deeper']);
      expect(result.events_considered).toBe(3);
      expect(result.run_ids).toEqual(['r-root', 'r-nested', 'r-deeper']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips malformed lines and emits learn.parse_error trajectory events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'learn-bad-'));
    try {
      const file = join(dir, 'mixed.jsonl');
      const valid_a: TrajectoryEvent = { kind: 'first', run_id: 'r' };
      const valid_b: TrajectoryEvent = { kind: 'second', run_id: 'r' };
      // line 1: valid; line 2: invalid JSON; line 3: valid JSON but missing kind; line 4: valid
      const content = [
        JSON.stringify(valid_a),
        '{not valid json',
        JSON.stringify({ no_kind: true }),
        JSON.stringify(valid_b),
      ].join('\n');
      await writeFile(file, content);

      let captured: LearnInput | undefined;
      const { logger, events: recorded } = recording_logger();
      const flow = learn({
        flow: trivial_flow,
        source: { kind: 'paths', paths: [file] },
        analyzer: step('a', (input: LearnInput) => {
          captured = input;
          return 'ok';
        }),
      });

      const result = await run(flow, undefined, {
        trajectory: logger,
        install_signal_handlers: false,
      });

      expect(captured?.events).toHaveLength(2);
      expect(captured?.events.map((e) => e.kind)).toEqual(['first', 'second']);
      expect(result.events_considered).toBe(2);

      const parse_errors = recorded.filter((e) => e.kind === 'learn.parse_error');
      expect(parse_errors).toHaveLength(2);
      expect(parse_errors[0]?.['path']).toBe(file);
      expect(parse_errors[0]?.['line']).toBe(2);
      expect(parse_errors[1]?.['path']).toBe(file);
      expect(parse_errors[1]?.['line']).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('propagates abort while reading files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'learn-abort-'));
    try {
      const event: TrajectoryEvent = { kind: 'x', run_id: 'r' };
      const line = JSON.stringify(event) + '\n';
      const big_payload = line.repeat(2_000);
      const paths = Array.from({ length: 200 }, (_, i) =>
        join(dir, `file_${String(i).padStart(4, '0')}.jsonl`),
      );
      await Promise.all(paths.map((p) => writeFile(p, big_payload)));

      const flow = learn({
        flow: trivial_flow,
        source: { kind: 'paths', paths },
        analyzer: step('a', () => 'done'),
      });

      const pending = run(flow, undefined);
      await wait(20);
      process.emit('SIGINT');

      await expect(pending).rejects.toBeInstanceOf(aborted_error);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
