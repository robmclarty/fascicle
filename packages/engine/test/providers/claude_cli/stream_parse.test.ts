/**
 * JSON-lines stream parser tests (spec §7, §12 #4, #5; F24).
 *
 * Covers line buffering across partial chunks, malformed-JSON tolerance,
 * unknown event tolerance, step_index transitions on new assistant events
 * after tool_result, atomic tool_call_start + tool_call_end emission, and
 * the full event-to-StreamChunk mapping table from spec §7.2.
 */

import { describe, expect, it } from 'vitest';
import {
  create_parser_state,
  feed_chunk,
  flush_remaining,
  snapshot,
} from '../../../src/providers/claude_cli/stream_parse.js';
import type { StreamChunk } from '../../../src/types.js';
import { create_captured_trajectory } from './fixtures/mock_helpers.js';

type ParsedOutcome = {
  chunks: StreamChunk[];
  state: ReturnType<typeof create_parser_state>;
  parsed: ReturnType<typeof snapshot>;
};

async function feed(
  lines: ReadonlyArray<string>,
  trajectory?: ReturnType<typeof create_captured_trajectory>,
): Promise<ParsedOutcome> {
  const state = create_parser_state();
  const chunks: StreamChunk[] = [];
  for (const line of lines) {
    await feed_chunk(state, `${line}\n`, chunks, undefined, trajectory?.logger);
  }
  await flush_remaining(state, chunks, undefined, trajectory?.logger);
  return { chunks, state, parsed: snapshot(state) };
}

function jline(obj: unknown): string {
  return JSON.stringify(obj);
}

const init_event = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  model: 'mock',
};

function result_event(extras: Record<string, unknown> = {}): unknown {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'sess-1',
    duration_ms: 12,
    total_cost_usd: 0.01,
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 5 },
    result: '',
    ...extras,
  };
}

describe('spec §7.2 — event-to-StreamChunk mapping', () => {
  it('§12 #4 — assistant text yields a text chunk', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi there' }] },
      }),
      jline(result_event({ result: 'hi there' })),
    ]);
    const text_chunks = chunks.filter((c) => c.kind === 'text');
    expect(text_chunks.length).toBe(1);
    expect(text_chunks[0]).toEqual({
      kind: 'text',
      text: 'hi there',
      step_index: 0,
    });
  });

  it('assistant tool_use emits tool_call_start followed by tool_call_end atomically', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/a' } },
          ],
        },
      }),
      jline(result_event()),
    ]);
    const tc_start = chunks.find((c) => c.kind === 'tool_call_start');
    const tc_end = chunks.find((c) => c.kind === 'tool_call_end');
    expect(tc_start).toBeDefined();
    expect(tc_end).toBeDefined();
    if (tc_start?.kind === 'tool_call_start') {
      expect(tc_start.id).toBe('tu-1');
      expect(tc_start.name).toBe('Read');
    }
    if (tc_end?.kind === 'tool_call_end') {
      expect(tc_end.input).toEqual({ path: '/a' });
    }
    expect(chunks).not.toContainEqual(
      expect.objectContaining({ kind: 'tool_call_input_delta' }),
    );
  });

  it('user tool_result yields a tool_result chunk with output', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: {} },
          ],
        },
      }),
      jline({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file body' },
          ],
        },
      }),
      jline(result_event()),
    ]);
    const tr = chunks.find((c) => c.kind === 'tool_result');
    expect(tr?.kind).toBe('tool_result');
    if (tr?.kind === 'tool_result') {
      expect(tr.id).toBe('tu-1');
      expect(tr.output).toBe('file body');
      expect(tr.error).toBeUndefined();
    }
  });

  it('user tool_result with is_error yields an error chunk without output', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-2', name: 'Read', input: {} }],
        },
      }),
      jline({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-2',
              content: 'permission denied',
              is_error: true,
            },
          ],
        },
      }),
      jline(result_event()),
    ]);
    const tr = chunks.find((c) => c.kind === 'tool_result' && c.id === 'tu-2');
    expect(tr).toBeDefined();
    if (tr?.kind === 'tool_result') {
      expect(tr.error?.message).toBe('permission denied');
      expect(tr.output).toBeUndefined();
    }
  });

  it('result event emits a finish chunk with usage', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }),
      jline(result_event()),
    ]);
    const finish = chunks.find((c) => c.kind === 'finish');
    expect(finish).toBeDefined();
    if (finish?.kind === 'finish') {
      expect(finish.finish_reason).toBe('stop');
      expect(finish.usage.input_tokens).toBe(10);
      expect(finish.usage.output_tokens).toBe(5);
    }
  });

  it('system init records cli_session_started in trajectory', async () => {
    const trajectory = create_captured_trajectory();
    await feed([jline(init_event), jline(result_event())], trajectory);
    const started = trajectory.events.filter((e) => e.kind === 'cli_session_started');
    expect(started.length).toBe(1);
    expect(started[0]?.['session_id']).toBe('sess-1');
    expect(started[0]?.['model']).toBe('mock');
  });
});

describe('step_index transitions', () => {
  it('new assistant after user tool_result emits step_finish and increments step_index', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }],
        },
      }),
      jline({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'x' }],
        },
      }),
      jline({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'follow-up' }] },
      }),
      jline(result_event()),
    ]);
    const step_finishes = chunks.filter((c) => c.kind === 'step_finish');
    expect(step_finishes.length).toBe(1);
    if (step_finishes[0]?.kind === 'step_finish') {
      expect(step_finishes[0].step_index).toBe(0);
    }
    const follow_up_text = chunks.find(
      (c) => c.kind === 'text' && c.text === 'follow-up',
    );
    expect(follow_up_text).toBeDefined();
    if (follow_up_text?.kind === 'text') {
      expect(follow_up_text.step_index).toBe(1);
    }
  });
});

describe('§7.4 — tolerance', () => {
  it('§12 #F24 — malformed JSON lines record cli_parse_error and continue', async () => {
    const trajectory = create_captured_trajectory();
    const { parsed } = await feed(
      [
        jline(init_event),
        'not-json',
        jline({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        }),
        jline(result_event({ result: 'ok' })),
      ],
      trajectory,
    );
    const parse_errors = trajectory.events.filter((e) => e.kind === 'cli_parse_error');
    expect(parse_errors.length).toBe(1);
    expect(parse_errors[0]?.['line']).toBe('not-json');
    expect(parsed.received_result).toBe(true);
  });

  it('unknown type records cli_unknown_event and continues', async () => {
    const trajectory = create_captured_trajectory();
    const { parsed } = await feed(
      [
        jline(init_event),
        jline({ type: 'future_kind', data: {} }),
        jline(result_event()),
      ],
      trajectory,
    );
    const unknowns = trajectory.events.filter((e) => e.kind === 'cli_unknown_event');
    expect(unknowns.length).toBe(1);
    expect(parsed.received_result).toBe(true);
  });

  it('empty or whitespace lines are ignored silently', async () => {
    const trajectory = create_captured_trajectory();
    const { parsed } = await feed(
      ['', '   ', jline(init_event), jline(result_event())],
      trajectory,
    );
    expect(
      trajectory.events.filter((e) => e.kind === 'cli_parse_error').length,
    ).toBe(0);
    expect(parsed.received_result).toBe(true);
  });

  it('non-object JSON (number, string) records cli_unknown_event', async () => {
    const trajectory = create_captured_trajectory();
    await feed(['42', '"hello"', jline(result_event())], trajectory);
    const unknowns = trajectory.events.filter((e) => e.kind === 'cli_unknown_event');
    expect(unknowns.length).toBe(2);
  });

  it('rejects assistant event with malformed message object as cli_unknown_event', async () => {
    const trajectory = create_captured_trajectory();
    const { parsed } = await feed(
      [
        jline(init_event),
        jline({ type: 'assistant', message: 'not-an-object' }),
        jline({ type: 'assistant', message: { content: 'not-an-array' } }),
        jline(result_event()),
      ],
      trajectory,
    );
    const unknowns = trajectory.events.filter((e) => e.kind === 'cli_unknown_event');
    expect(unknowns.length).toBe(2);
    expect(parsed.received_result).toBe(true);
  });

  it('silently drops assistant content entries with unknown type or missing required fields', async () => {
    const trajectory = create_captured_trajectory();
    const { chunks } = await feed(
      [
        jline(init_event),
        jline({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'kept' },
              { type: 'future_part', data: 'x' },
              { type: 'tool_use', name: 'Read', input: {} },
              { type: 'text' },
              { type: 'tool_use', id: 'tu-1', name: 'Read', input: { p: 'ok' } },
            ],
          },
        }),
        jline(result_event({ result: 'kept' })),
      ],
      trajectory,
    );
    const texts = chunks.filter((c) => c.kind === 'text');
    const tool_starts = chunks.filter((c) => c.kind === 'tool_call_start');
    expect(texts.length).toBe(1);
    expect(tool_starts.length).toBe(1);
    expect(
      trajectory.events.filter((e) => e.kind === 'cli_unknown_event').length,
    ).toBe(0);
  });
});

describe('line buffering across partial chunks', () => {
  it('accumulates partial JSON across multiple feed_chunk calls', async () => {
    const state = create_parser_state();
    const chunks: StreamChunk[] = [];
    const full = jline(init_event) + '\n' + jline(result_event()) + '\n';
    const mid = Math.floor(full.length / 2);
    await feed_chunk(state, full.slice(0, mid), chunks, undefined, undefined);
    await feed_chunk(state, full.slice(mid), chunks, undefined, undefined);
    await flush_remaining(state, chunks, undefined, undefined);
    const parsed = snapshot(state);
    expect(parsed.received_result).toBe(true);
  });

  it('final incomplete line without newline is flushed by flush_remaining', async () => {
    const state = create_parser_state();
    const chunks: StreamChunk[] = [];
    const text =
      jline(init_event) + '\n' + jline({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial' }] },
      }) + '\n' + jline(result_event({ result: 'partial' }));
    await feed_chunk(state, text, chunks, undefined, undefined);
    await flush_remaining(state, chunks, undefined, undefined);
    const parsed = snapshot(state);
    expect(parsed.received_result).toBe(true);
    expect(parsed.final_text).toBe('partial');
  });
});

describe('on_chunk dispatch ordering', () => {
  it('§12 #5 — dispatches chunks to on_chunk in source order', async () => {
    const received: string[] = [];
    const state = create_parser_state();
    const chunks: StreamChunk[] = [];
    const dispatch = async (chunk: StreamChunk): Promise<void> => {
      received.push(chunk.kind);
    };
    const lines = [
      jline(init_event),
      jline({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
      jline(result_event({ result: 'hello' })),
    ];
    for (const line of lines) {
      await feed_chunk(state, `${line}\n`, chunks, dispatch, undefined);
    }
    expect(received).toEqual(['text', 'finish']);
  });
});

describe('usage mapping', () => {
  it('maps cache_read_input_tokens -> cached_input_tokens and cache_creation_input_tokens -> cache_write_tokens', async () => {
    const { parsed } = await feed([
      jline(init_event),
      jline(
        result_event({
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 10,
          },
        }),
      ),
    ]);
    expect(parsed.final_usage.input_tokens).toBe(100);
    expect(parsed.final_usage.output_tokens).toBe(20);
    expect(parsed.final_usage.cached_input_tokens).toBe(50);
    expect(parsed.final_usage.cache_write_tokens).toBe(10);
  });

  it('treats missing usage fields as zero (input_tokens, output_tokens)', async () => {
    const { parsed } = await feed([
      jline(init_event),
      jline({ type: 'result', subtype: 'success' }),
    ]);
    expect(parsed.final_usage.input_tokens).toBe(0);
    expect(parsed.final_usage.output_tokens).toBe(0);
  });
});

describe('snapshot() exposes parsed result safely', () => {
  it('returns a shallow copy; subsequent mutation of internal state does not affect snapshot', async () => {
    const { state, parsed } = await feed([jline(init_event), jline(result_event())]);
    const turn_count_before = parsed.turns.length;
    state.turns.push({
      step_index: 99,
      text: 'x',
      tool_calls: [],
      tool_results: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(parsed.turns.length).toBe(turn_count_before);
  });
});
