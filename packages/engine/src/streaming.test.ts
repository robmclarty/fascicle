import { describe, expect, it } from 'vitest';
import {
  create_chunk_dispatcher,
  normalize_chunk,
  type RawProviderStreamEvent,
} from './streaming.js';
import type { StreamChunk } from './types.js';
import { on_chunk_error } from './errors.js';

describe('normalize_chunk', () => {
  it('maps text-delta events', () => {
    const chunk = normalize_chunk({ type: 'text-delta', delta: 'hi' }, 0);
    expect(chunk).toEqual({ kind: 'text', text: 'hi', step_index: 0 });
  });

  it('maps reasoning-delta events', () => {
    const chunk = normalize_chunk({ type: 'reasoning-delta', delta: 'think' }, 2);
    expect(chunk).toEqual({ kind: 'reasoning', text: 'think', step_index: 2 });
  });

  it('maps tool-input lifecycle', () => {
    const start = normalize_chunk(
      { type: 'tool-input-start', id: 'c1', tool_name: 'search' },
      0,
    );
    const delta = normalize_chunk(
      { type: 'tool-input-delta', id: 'c1', delta: '{"q":' },
      0,
    );
    const end = normalize_chunk(
      { type: 'tool-input-end', id: 'c1', input: { q: 'hi' } },
      0,
    );
    expect(start).toEqual({ kind: 'tool_call_start', id: 'c1', name: 'search', step_index: 0 });
    expect(delta).toEqual({
      kind: 'tool_call_input_delta',
      id: 'c1',
      delta: '{"q":',
      step_index: 0,
    });
    expect(end).toEqual({ kind: 'tool_call_end', id: 'c1', input: { q: 'hi' }, step_index: 0 });
  });

  it('maps tool-result with error or output', () => {
    const ok = normalize_chunk({ type: 'tool-result', id: 'c1', output: 42 }, 0);
    expect(ok).toEqual({ kind: 'tool_result', id: 'c1', output: 42, step_index: 0 });
    const fail = normalize_chunk(
      { type: 'tool-result', id: 'c1', error: { message: 'boom' } },
      0,
    );
    expect(fail).toEqual({
      kind: 'tool_result',
      id: 'c1',
      error: { message: 'boom' },
      step_index: 0,
    });
  });

  it('maps finish-step and finish', () => {
    const step_finish = normalize_chunk(
      {
        type: 'finish-step',
        finish_reason: 'stop',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
      3,
    );
    const finish = normalize_chunk(
      {
        type: 'finish',
        finish_reason: 'stop',
        usage: { input_tokens: 10, output_tokens: 20 },
      },
      0,
    );
    expect(step_finish).toEqual({
      kind: 'step_finish',
      step_index: 3,
      finish_reason: 'stop',
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(finish).toEqual({
      kind: 'finish',
      finish_reason: 'stop',
      usage: { input_tokens: 10, output_tokens: 20 },
    });
  });

  it('returns undefined for unknown event types', () => {
    const raw = { type: 'unknown-kind' } as unknown as RawProviderStreamEvent;
    expect(normalize_chunk(raw, 0)).toBeUndefined();
  });

  it('preserves step_index and natural ordering across a synthesized stream', () => {
    const events: RawProviderStreamEvent[] = [
      { type: 'text-delta', delta: 'he' },
      { type: 'text-delta', delta: 'llo' },
      { type: 'tool-input-start', id: 't1', tool_name: 'get' },
      { type: 'tool-input-delta', id: 't1', delta: '{}' },
      { type: 'tool-input-end', id: 't1', input: {} },
      { type: 'tool-result', id: 't1', output: 'ok' },
      { type: 'finish-step', finish_reason: 'tool_calls', usage: { input_tokens: 1, output_tokens: 2 } },
      { type: 'finish', finish_reason: 'stop', usage: { input_tokens: 1, output_tokens: 2 } },
    ];
    const chunks = events
      .map((e) => normalize_chunk(e, 0))
      .filter((c): c is StreamChunk => c !== undefined);
    expect(chunks.map((c) => c.kind)).toEqual([
      'text',
      'text',
      'tool_call_start',
      'tool_call_input_delta',
      'tool_call_end',
      'tool_result',
      'step_finish',
      'finish',
    ]);
    for (const c of chunks) {
      if (c.kind === 'finish') continue;
      expect(c.step_index).toBe(0);
    }
  });
});

describe('create_chunk_dispatcher', () => {
  it('is a no-op when on_chunk is undefined', async () => {
    const dispatcher = create_chunk_dispatcher(undefined);
    await dispatcher.dispatch({ kind: 'text', text: 'hi', step_index: 0 });
    expect(dispatcher.aborted()).toBe(false);
  });

  it('invokes on_chunk and records failure on sync throw', async () => {
    const seen: string[] = [];
    const dispatcher = create_chunk_dispatcher((chunk) => {
      if (chunk.kind === 'text') {
        if (chunk.text === 'boom') throw new Error('bad');
        seen.push(chunk.text);
      }
    });
    await dispatcher.dispatch({ kind: 'text', text: 'ok', step_index: 0 });
    await expect(
      dispatcher.dispatch({ kind: 'text', text: 'boom', step_index: 0 }),
    ).rejects.toBeInstanceOf(on_chunk_error);
    expect(dispatcher.aborted()).toBe(true);
    // Subsequent dispatch does nothing.
    await dispatcher.dispatch({ kind: 'text', text: 'silent', step_index: 0 });
    expect(seen).toEqual(['ok']);
  });

  it('records failure on a rejected async on_chunk promise', async () => {
    const dispatcher = create_chunk_dispatcher(async () => {
      throw new Error('async boom');
    });
    await expect(
      dispatcher.dispatch({ kind: 'text', text: 'x', step_index: 0 }),
    ).rejects.toBeInstanceOf(on_chunk_error);
    expect(dispatcher.aborted()).toBe(true);
  });
});
