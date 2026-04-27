import { describe, expect, it } from 'vitest';
import {
  custom_event_schema,
  emit_event_schema,
  span_end_event_schema,
  span_start_event_schema,
  trajectory_event_schema,
} from './trajectory.js';
import type { ParsedTrajectoryEvent } from './trajectory.js';

describe('trajectory_event_schema', () => {
  it('parses a well-formed span_start as SpanStartEvent', () => {
    const wire = {
      kind: 'span_start',
      span_id: 'sequence:abcd',
      name: 'sequence',
      id: 'sequence_1',
      run_id: 'run-1',
    };
    const parsed = trajectory_event_schema.parse(wire);
    expect(parsed.kind).toBe('span_start');
    expect(span_start_event_schema.safeParse(wire).success).toBe(true);
    expect((parsed as { run_id?: string }).run_id).toBe('run-1');
  });

  it('parses a well-formed span_end as SpanEndEvent', () => {
    const wire = { kind: 'span_end', span_id: 'sequence:abcd', id: 'sequence_1' };
    const parsed = trajectory_event_schema.parse(wire);
    expect(parsed.kind).toBe('span_end');
    expect(span_end_event_schema.safeParse(wire).success).toBe(true);
  });

  it('parses a ctx.emit event as EmitEvent', () => {
    const wire = { kind: 'emit', whatever: 1 };
    const parsed = trajectory_event_schema.parse(wire);
    expect(parsed.kind).toBe('emit');
    expect(emit_event_schema.safeParse(wire).success).toBe(true);
  });

  it('falls back to custom for any unknown kind, preserving extra fields', () => {
    const wire = {
      kind: 'cost',
      step_index: 0,
      total_usd: 0.001,
      input_usd: 0.0005,
      output_usd: 0.0005,
    };
    const parsed = trajectory_event_schema.parse(wire);
    expect(parsed.kind).toBe('cost');
    const as_custom = parsed as Record<string, unknown>;
    expect(as_custom['step_index']).toBe(0);
    expect(as_custom['total_usd']).toBe(0.001);
  });

  it('round-trips every well-known shape via JSON without loss', () => {
    const samples: ParsedTrajectoryEvent[] = [
      { kind: 'span_start', span_id: 's:1', name: 'sequence', id: 'sequence_1', run_id: 'r-1' },
      { kind: 'span_end', span_id: 's:1', id: 'sequence_1', run_id: 'r-1' },
      { kind: 'emit', label: 'progress', value: 42, run_id: 'r-1' },
      { kind: 'cost', step_index: 0, total_usd: 0.001, run_id: 'r-1' },
      { kind: 'cli_session_started', session_id: 'abc', model: 'sonnet' },
    ];
    for (const original of samples) {
      const wire = JSON.stringify(original);
      const re_parsed = trajectory_event_schema.parse(JSON.parse(wire));
      expect(re_parsed).toEqual(original);
    }
  });

  it('rejects values that are not objects with a string kind', () => {
    expect(trajectory_event_schema.safeParse(null).success).toBe(false);
    expect(trajectory_event_schema.safeParse('string').success).toBe(false);
    expect(trajectory_event_schema.safeParse({ no_kind: true }).success).toBe(false);
    expect(custom_event_schema.safeParse({ kind: 42 }).success).toBe(false);
  });
});
