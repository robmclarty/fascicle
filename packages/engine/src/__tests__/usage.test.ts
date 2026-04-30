import { describe, expect, it } from 'vitest';
import { sum_usage } from '../usage.js';
import type { StepRecord } from '../types.js';

function step(index: number, usage: StepRecord['usage']): StepRecord {
  return {
    index,
    text: '',
    tool_calls: [],
    usage,
    finish_reason: 'stop',
  };
}

describe('sum_usage', () => {
  it('sums required fields', () => {
    const total = sum_usage([
      step(0, { input_tokens: 10, output_tokens: 20 }),
      step(1, { input_tokens: 30, output_tokens: 5 }),
    ]);
    expect(total.input_tokens).toBe(40);
    expect(total.output_tokens).toBe(25);
  });

  it('leaves optional fields absent if no step reports them', () => {
    const total = sum_usage([
      step(0, { input_tokens: 10, output_tokens: 20 }),
      step(1, { input_tokens: 30, output_tokens: 5 }),
    ]);
    expect('reasoning_tokens' in total).toBe(false);
    expect('cached_input_tokens' in total).toBe(false);
    expect('cache_write_tokens' in total).toBe(false);
  });

  it('sums optional fields when present on some steps, treating absent as 0', () => {
    const total = sum_usage([
      step(0, { input_tokens: 10, output_tokens: 20, reasoning_tokens: 7 }),
      step(1, { input_tokens: 30, output_tokens: 5 }),
      step(2, { input_tokens: 5, output_tokens: 3, reasoning_tokens: 2, cached_input_tokens: 11 }),
    ]);
    expect(total.reasoning_tokens).toBe(9);
    expect(total.cached_input_tokens).toBe(11);
    expect('cache_write_tokens' in total).toBe(false);
  });

  it('returns zeros for an empty step array', () => {
    const total = sum_usage([]);
    expect(total).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});
