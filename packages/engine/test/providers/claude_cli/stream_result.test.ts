/**
 * build_generate_result tests (spec §5.4, §7.3, §10).
 *
 * Exercises the internal helpers of stream_result.ts through the public
 * build_generate_result entry point — sum_usage (mixed cache/reasoning
 * presence across turns), aggregate_cost_breakdowns (mixed cache field
 * presence in per-turn breakdowns), normalize_turns synthetic path
 * (result-only stream with no assistant turns), and tool_call_record
 * error-result mapping.
 */

import { describe, expect, it } from 'vitest';
import type { AliasTarget } from '../../../src/types.js';
import { build_generate_result } from '../../../src/providers/claude_cli/stream_result.js';
import type { ParsedStream } from '../../../src/providers/claude_cli/stream_parse.js';

const resolved: AliasTarget = { provider: 'claude_cli', model_id: 'claude-sonnet-4-6' };

function make_parsed(overrides: Partial<ParsedStream> = {}): ParsedStream {
  const base: ParsedStream = {
    final_text: '',
    final_usage: { input_tokens: 0, output_tokens: 0 },
    turns: [],
    is_error: false,
    received_result: true,
  };
  return { ...base, ...overrides };
}

describe('normalize_turns synthetic path', () => {
  it('synthesizes a single turn when parsed.turns is empty', () => {
    const parsed = make_parsed({
      final_text: 'hello',
      final_usage: { input_tokens: 4, output_tokens: 2 },
      session_id: 'sess-1',
      duration_ms: 42,
    });
    const result = build_generate_result({ parsed, resolved });
    expect(result.steps.length).toBe(1);
    expect(result.steps[0]?.text).toBe('hello');
    expect(result.steps[0]?.tool_calls).toEqual([]);
    expect(result.steps[0]?.finish_reason).toBe('stop');
    expect(result.usage.input_tokens).toBe(4);
    expect(result.content).toBe('hello');
  });

  it('omits cost on steps when parsed.total_cost_usd is undefined', () => {
    const parsed = make_parsed({
      final_text: 'no-cost',
      final_usage: { input_tokens: 1, output_tokens: 1 },
    });
    const result = build_generate_result({ parsed, resolved });
    expect(result.cost).toBeUndefined();
    expect(result.steps[0]?.cost).toBeUndefined();
  });

  it('omits provider_reported when both session_id and duration_ms are missing', () => {
    const parsed = make_parsed({ final_text: 'plain' });
    const result = build_generate_result({ parsed, resolved });
    expect(result.provider_reported).toBeUndefined();
  });
});

describe('sum_usage across multi-turn', () => {
  it('sums cached_input_tokens only from turns that provide it', () => {
    const parsed = make_parsed({
      final_text: 'second',
      total_cost_usd: 0.02,
      turns: [
        {
          step_index: 0,
          text: 'first',
          tool_calls: [],
          tool_results: [],
          usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 5 },
        },
        {
          step_index: 1,
          text: 'second',
          tool_calls: [],
          tool_results: [],
          usage: { input_tokens: 12, output_tokens: 4 },
        },
      ],
    });
    const result = build_generate_result({ parsed, resolved });
    expect(result.usage.input_tokens).toBe(22);
    expect(result.usage.output_tokens).toBe(7);
    expect(result.usage.cached_input_tokens).toBe(5);
    expect(result.usage.cache_write_tokens).toBeUndefined();
    expect(result.usage.reasoning_tokens).toBeUndefined();
  });

  it('sums cache_write_tokens and reasoning_tokens when present on any turn', () => {
    const parsed = make_parsed({
      final_text: 'done',
      total_cost_usd: 0.05,
      turns: [
        {
          step_index: 0,
          text: 'a',
          tool_calls: [],
          tool_results: [],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_write_tokens: 6,
            reasoning_tokens: 3,
          },
        },
        {
          step_index: 1,
          text: 'b',
          tool_calls: [],
          tool_results: [],
          usage: { input_tokens: 8, output_tokens: 2, cache_write_tokens: 2 },
        },
      ],
    });
    const result = build_generate_result({ parsed, resolved });
    expect(result.usage.cache_write_tokens).toBe(8);
    expect(result.usage.reasoning_tokens).toBe(3);
  });
});

describe('aggregate_cost_breakdowns branches', () => {
  it('aggregates cached_input_usd and cache_write_usd only when at least one turn carries them', () => {
    const parsed = make_parsed({
      final_text: 'x',
      total_cost_usd: 0.1,
      turns: [
        {
          step_index: 0,
          text: 'a',
          tool_calls: [],
          tool_results: [],
          usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50 },
        },
        {
          step_index: 1,
          text: 'b',
          tool_calls: [],
          tool_results: [],
          usage: { input_tokens: 40, output_tokens: 20, cache_write_tokens: 10 },
        },
      ],
    });
    const result = build_generate_result({ parsed, resolved });
    expect(result.cost).toBeDefined();
    expect(result.cost?.total_usd).toBeCloseTo(0.1, 9);
    expect(result.cost?.cached_input_usd).toBeDefined();
    expect(result.cost?.cache_write_usd).toBeDefined();
    expect(result.cost?.is_estimate).toBe(true);
    expect(result.cost?.currency).toBe('USD');
  });

  it('omits cached and cache_write cost fields when no turn carries cache tokens', () => {
    const parsed = make_parsed({
      final_text: 'plain',
      total_cost_usd: 0.04,
      turns: [
        {
          step_index: 0,
          text: 'plain',
          tool_calls: [],
          tool_results: [],
          usage: { input_tokens: 50, output_tokens: 10 },
        },
      ],
    });
    const result = build_generate_result({ parsed, resolved });
    expect(result.cost?.cached_input_usd).toBeUndefined();
    expect(result.cost?.cache_write_usd).toBeUndefined();
  });
});

describe('tool_call_record mapping', () => {
  it('attaches output when a matching tool_result is present', () => {
    const parsed = make_parsed({
      final_text: '',
      total_cost_usd: 0.01,
      turns: [
        {
          step_index: 0,
          text: 'calling',
          tool_calls: [{ id: 'tu-1', name: 'Read', input: { path: '/a' } }],
          tool_results: [{ id: 'tu-1', output: 'contents' }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      ],
    });
    const result = build_generate_result({ parsed, resolved });
    const call = result.tool_calls[0];
    expect(call?.output).toBe('contents');
    expect(call?.error).toBeUndefined();
  });

  it('attaches error when the matching tool_result carries an error', () => {
    const parsed = make_parsed({
      final_text: '',
      total_cost_usd: 0.01,
      turns: [
        {
          step_index: 0,
          text: 'calling',
          tool_calls: [{ id: 'tu-1', name: 'Read', input: {} }],
          tool_results: [{ id: 'tu-1', error: { message: 'denied' } }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      ],
    });
    const result = build_generate_result({ parsed, resolved });
    const call = result.tool_calls[0];
    expect(call?.error?.message).toBe('denied');
    expect(call?.output).toBeUndefined();
  });

  it('leaves output and error undefined when no matching tool_result exists', () => {
    const parsed = make_parsed({
      final_text: '',
      total_cost_usd: 0.01,
      turns: [
        {
          step_index: 0,
          text: 'calling',
          tool_calls: [{ id: 'tu-orphan', name: 'Read', input: {} }],
          tool_results: [],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      ],
    });
    const result = build_generate_result({ parsed, resolved });
    const call = result.tool_calls[0];
    expect(call?.id).toBe('tu-orphan');
    expect(call?.output).toBeUndefined();
    expect(call?.error).toBeUndefined();
  });
});

describe('step finish_reason assignment', () => {
  it('marks all non-terminal steps as tool_calls and the final step as stop', () => {
    const parsed = make_parsed({
      final_text: 'final',
      total_cost_usd: 0.03,
      turns: [
        {
          step_index: 0,
          text: 'a',
          tool_calls: [{ id: 't1', name: 'Read', input: {} }],
          tool_results: [{ id: 't1', output: 'x' }],
          usage: { input_tokens: 3, output_tokens: 1 },
        },
        {
          step_index: 1,
          text: 'b',
          tool_calls: [{ id: 't2', name: 'Read', input: {} }],
          tool_results: [{ id: 't2', output: 'y' }],
          usage: { input_tokens: 4, output_tokens: 1 },
        },
        {
          step_index: 2,
          text: 'final',
          tool_calls: [],
          tool_results: [],
          usage: { input_tokens: 2, output_tokens: 2 },
        },
      ],
    });
    const result = build_generate_result({ parsed, resolved });
    expect(result.steps.map((s) => s.finish_reason)).toEqual([
      'tool_calls',
      'tool_calls',
      'stop',
    ]);
  });
});
