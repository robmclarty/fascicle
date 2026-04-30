import { describe, expect, it } from 'vitest';
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core';
import {
  create_option_ignored_dedup,
  create_pricing_missing_dedup,
  end_generate_span,
  end_step_span,
  record_cost,
  record_effort_ignored,
  record_request_sent,
  record_response_received,
  record_tool_approval,
  record_tool_call,
  start_generate_span,
  start_step_span,
} from '../trajectory.js';

function create_recorder(): {
  trajectory: TrajectoryLogger;
  events: Array<{ kind: 'record' | 'start_span' | 'end_span'; payload: unknown }>;
} {
  const events: Array<{ kind: 'record' | 'start_span' | 'end_span'; payload: unknown }> = [];
  let counter = 0;
  const trajectory: TrajectoryLogger = {
    record(event: TrajectoryEvent) {
      events.push({ kind: 'record', payload: event });
    },
    start_span(name, meta) {
      counter += 1;
      const id = `span-${counter}`;
      events.push({ kind: 'start_span', payload: { id, name, meta } });
      return id;
    },
    end_span(id, meta) {
      events.push({ kind: 'end_span', payload: { id, meta } });
    },
  };
  return { trajectory, events };
}

describe('trajectory helpers', () => {
  it('no-op when trajectory is undefined', () => {
    expect(start_generate_span(undefined, {
      model: 'm',
      provider: 'p',
      model_id: 'x',
      has_tools: false,
      has_schema: false,
      streaming: false,
    })).toBeUndefined();

    end_generate_span(undefined, undefined, { finish_reason: 'stop' });
    const id = start_step_span(undefined, 0);
    expect(id).toBeUndefined();
    end_step_span(undefined, undefined, { finish_reason: 'stop' });
    record_request_sent(undefined, 0, 10);
    record_response_received(undefined, 0, 5, 'stop');
    record_tool_call(undefined, {
      step_index: 0,
      name: 'foo',
      tool_call_id: 'c1',
      input: {},
      duration_ms: 1,
    });
    record_cost(undefined, 0, {
      total_usd: 0,
      input_usd: 0,
      output_usd: 0,
      currency: 'USD',
      is_estimate: true,
    }, 'engine_derived');
    record_effort_ignored(undefined, 'foo');
    record_tool_approval(undefined, 'tool_approval_requested', {
      tool_name: 'foo',
      step_index: 0,
      tool_call_id: 'c1',
    });
    // No exceptions thrown.
  });

  it('emits the engine.generate and engine.generate.step spans', () => {
    const { trajectory, events } = create_recorder();
    const generate_id = start_generate_span(trajectory, {
      model: 'sonnet',
      provider: 'anthropic',
      model_id: 'claude-sonnet-4-6',
      has_tools: true,
      has_schema: false,
      streaming: false,
    });
    const step_id = start_step_span(trajectory, 0);
    end_step_span(trajectory, step_id, {
      finish_reason: 'stop',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    end_generate_span(trajectory, generate_id, {
      finish_reason: 'stop',
      model_resolved: { provider: 'anthropic', model_id: 'claude-sonnet-4-6' },
    });

    const start_events = events.filter((e) => e.kind === 'start_span');
    expect(start_events).toHaveLength(2);
    expect((start_events[0]!.payload as { name: string }).name).toBe('engine.generate');
    expect((start_events[1]!.payload as { name: string }).name).toBe('engine.generate.step');
  });

  it('records request_sent / response_received with the right shape', () => {
    const { trajectory, events } = create_recorder();
    record_request_sent(trajectory, 0, 42);
    record_response_received(trajectory, 0, 5, 'stop');
    const records = events.filter((e) => e.kind === 'record').map((e) => e.payload);
    expect(records[0]).toMatchObject({
      kind: 'request_sent',
      step_index: 0,
      prompt_tokens_estimated: 42,
    });
    expect(records[1]).toMatchObject({
      kind: 'response_received',
      step_index: 0,
      finish_reason: 'stop',
      output_tokens: 5,
    });
  });

  it('records tool_call with duration and optional error', () => {
    const { trajectory, events } = create_recorder();
    record_tool_call(trajectory, {
      step_index: 1,
      name: 'search',
      tool_call_id: 'c1',
      input: { q: 'hi' },
      duration_ms: 42,
    });
    record_tool_call(trajectory, {
      step_index: 1,
      name: 'search',
      tool_call_id: 'c2',
      input: { q: 'bad' },
      duration_ms: 10,
      error: { message: 'boom' },
    });
    const records = events.filter((e) => e.kind === 'record').map((e) => e.payload);
    expect(records[0]).toMatchObject({ kind: 'tool_call', name: 'search', duration_ms: 42 });
    expect(records[1]).toMatchObject({
      kind: 'tool_call',
      tool_call_id: 'c2',
      error: { message: 'boom' },
    });
  });

  it('records cost components including optional cache/reasoning fields', () => {
    const { trajectory, events } = create_recorder();
    record_cost(trajectory, 0, {
      total_usd: 0.1,
      input_usd: 0.05,
      output_usd: 0.04,
      cached_input_usd: 0.01,
      currency: 'USD',
      is_estimate: true,
    }, 'engine_derived');
    const records = events.filter((e) => e.kind === 'record').map((e) => e.payload);
    expect(records[0]).toMatchObject({
      kind: 'cost',
      step_index: 0,
      source: 'engine_derived',
      total_usd: 0.1,
      cached_input_usd: 0.01,
    });
    expect('cache_write_usd' in (records[0] as object)).toBe(false);
  });

  it('threads the source discriminant through cost events', () => {
    const { trajectory, events } = create_recorder();
    const fixture_cost = {
      total_usd: 0.2,
      input_usd: 0.1,
      output_usd: 0.1,
      currency: 'USD' as const,
      is_estimate: true as const,
    };
    record_cost(trajectory, 0, fixture_cost, 'engine_derived');
    record_cost(trajectory, 1, fixture_cost, 'provider_reported');
    const records = events.filter((e) => e.kind === 'record').map((e) => e.payload);
    expect(records[0]).toMatchObject({ kind: 'cost', step_index: 0, source: 'engine_derived' });
    expect(records[1]).toMatchObject({ kind: 'cost', step_index: 1, source: 'provider_reported' });
  });

  it('deduplicates pricing_missing per unique provider/model within a generate call', () => {
    const { trajectory, events } = create_recorder();
    const dedup = create_pricing_missing_dedup(trajectory);
    dedup.emit('openrouter', 'foo/bar');
    dedup.emit('openrouter', 'foo/bar');
    dedup.emit('openrouter', 'foo/baz');
    const records = events.filter((e) => e.kind === 'record').map((e) => e.payload);
    expect(records).toHaveLength(2);
  });

  it('deduplicates option_ignored per option key within a generate call', () => {
    const { trajectory, events } = create_recorder();
    const dedup = create_option_ignored_dedup(trajectory);
    dedup.emit('max_steps', 'claude_cli');
    dedup.emit('max_steps', 'claude_cli');
    dedup.emit('tool_error_policy', 'claude_cli');
    const records = events.filter((e) => e.kind === 'record').map((e) => e.payload);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: 'option_ignored',
      option: 'max_steps',
      provider: 'claude_cli',
    });
    expect(records[1]).toMatchObject({
      kind: 'option_ignored',
      option: 'tool_error_policy',
      provider: 'claude_cli',
    });
  });

  it('option_ignored dedup is a no-op when trajectory is undefined', () => {
    const dedup = create_option_ignored_dedup(undefined);
    dedup.emit('max_steps', 'claude_cli');
    dedup.emit('on_tool_approval', 'claude_cli');
    // No exception thrown.
  });

  it('records effort_ignored and tool_approval event kinds', () => {
    const { trajectory, events } = create_recorder();
    record_effort_ignored(trajectory, 'gpt-4o-mini');
    record_tool_approval(trajectory, 'tool_approval_requested', {
      tool_name: 'exec',
      step_index: 0,
      tool_call_id: 'c1',
    });
    record_tool_approval(trajectory, 'tool_approval_denied', {
      tool_name: 'exec',
      step_index: 0,
      tool_call_id: 'c1',
    });
    const records = events.filter((e) => e.kind === 'record').map((e) => e.payload);
    expect(records.map((r) => (r as { kind: string }).kind)).toEqual([
      'effort_ignored',
      'tool_approval_requested',
      'tool_approval_denied',
    ]);
  });
});
