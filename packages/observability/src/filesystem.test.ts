import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filesystem_logger } from './filesystem.js';

let work_dir = '';

beforeEach(() => {
  work_dir = mkdtempSync(join(tmpdir(), 'fascicle-fs-logger-'));
});

afterEach(() => {
  rmSync(work_dir, { recursive: true, force: true });
});

function read_lines(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l): Record<string, unknown> => JSON.parse(l) as Record<string, unknown>);
}

describe('filesystem_logger', () => {
  it('appends each record as one JSON object per line', () => {
    const output_path = join(work_dir, 'trajectory.jsonl');
    const logger = filesystem_logger({ output_path });

    logger.record({ kind: 'emit', text: 'hello' });
    logger.record({ kind: 'emit', text: 'world' });

    const lines = read_lines(output_path);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ kind: 'emit', text: 'hello' });
    expect(lines[1]).toEqual({ kind: 'emit', text: 'world' });
  });

  it('emits span_start and span_end for each start/end call', () => {
    const output_path = join(work_dir, 'trajectory.jsonl');
    const logger = filesystem_logger({ output_path });

    const id = logger.start_span('step', { id: 'a' });
    logger.end_span(id, { id: 'a' });

    const lines = read_lines(output_path);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: 'span_start', span_id: id, name: 'step', id: 'a' });
    expect(lines[1]).toMatchObject({ kind: 'span_end', span_id: id, id: 'a' });
  });

  it('nested sequential spans carry parent_span_id on the child', () => {
    const output_path = join(work_dir, 'trajectory.jsonl');
    const logger = filesystem_logger({ output_path });

    const outer = logger.start_span('sequence', { id: 'seq_1' });
    const inner = logger.start_span('step', { id: 'a' });
    logger.end_span(inner, { id: 'a' });
    logger.end_span(outer, { id: 'seq_1' });

    const lines = read_lines(output_path);
    const outer_start = lines.find((l) => l['span_id'] === outer && l['kind'] === 'span_start');
    const inner_start = lines.find((l) => l['span_id'] === inner && l['kind'] === 'span_start');

    expect(outer_start?.['parent_span_id']).toBeUndefined();
    expect(inner_start?.['parent_span_id']).toBe(outer);
  });

  it('creates the output directory if missing', () => {
    const nested_path = join(work_dir, 'a', 'b', 'c', 'out.jsonl');
    const logger = filesystem_logger({ output_path: nested_path });
    logger.record({ kind: 'ping' });
    const lines = read_lines(nested_path);
    expect(lines).toEqual([{ kind: 'ping' }]);
  });

  it('two distinct logger instances (distinct paths) do not share state', () => {
    const path_a = join(work_dir, 'a.jsonl');
    const path_b = join(work_dir, 'b.jsonl');
    const logger_a = filesystem_logger({ output_path: path_a });
    const logger_b = filesystem_logger({ output_path: path_b });

    logger_a.record({ kind: 'from_a' });
    logger_b.record({ kind: 'from_b' });

    expect(read_lines(path_a)).toEqual([{ kind: 'from_a' }]);
    expect(read_lines(path_b)).toEqual([{ kind: 'from_b' }]);
  });
});
