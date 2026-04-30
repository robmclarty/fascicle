import { describe, expect, it } from 'vitest';
import {
  compute_cost,
  DEFAULT_PRICING,
  FREE_PROVIDERS,
  pricing_key,
} from '../pricing.js';
import type { Pricing } from '../types.js';

describe('DEFAULT_PRICING', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_PRICING)).toBe(true);
  });

  it('includes the documented anthropic / openai / google entries', () => {
    expect(DEFAULT_PRICING['anthropic:claude-opus-4-7']).toEqual({
      input_per_million: 5.0,
      output_per_million: 25.0,
      cached_input_per_million: 0.5,
      cache_write_per_million: 6.25,
    });
    expect(DEFAULT_PRICING['anthropic:claude-sonnet-4-6']).toEqual({
      input_per_million: 3.0,
      output_per_million: 15.0,
      cached_input_per_million: 0.3,
      cache_write_per_million: 3.75,
    });
    expect(DEFAULT_PRICING['anthropic:claude-haiku-4-5']).toEqual({
      input_per_million: 1.0,
      output_per_million: 5.0,
      cached_input_per_million: 0.1,
      cache_write_per_million: 1.25,
    });
    expect(DEFAULT_PRICING['openai:gpt-4o']).toEqual({
      input_per_million: 2.5,
      output_per_million: 10.0,
      cached_input_per_million: 1.25,
    });
    expect(DEFAULT_PRICING['openai:gpt-4o-mini']).toEqual({
      input_per_million: 0.15,
      output_per_million: 0.6,
      cached_input_per_million: 0.075,
    });
    expect(DEFAULT_PRICING['google:gemini-2.5-pro']).toEqual({
      input_per_million: 1.25,
      output_per_million: 5.0,
    });
    expect(DEFAULT_PRICING['google:gemini-2.5-flash']).toEqual({
      input_per_million: 0.075,
      output_per_million: 0.3,
    });
  });

  it('ships no ollama / lmstudio / openrouter entries', () => {
    for (const key of Object.keys(DEFAULT_PRICING)) {
      expect(key.startsWith('ollama:')).toBe(false);
      expect(key.startsWith('lmstudio:')).toBe(false);
      expect(key.startsWith('openrouter:')).toBe(false);
    }
  });
});

describe('FREE_PROVIDERS', () => {
  it('contains ollama and lmstudio', () => {
    expect(FREE_PROVIDERS.has('ollama')).toBe(true);
    expect(FREE_PROVIDERS.has('lmstudio')).toBe(true);
  });

  it('does not contain paid providers', () => {
    expect(FREE_PROVIDERS.has('anthropic')).toBe(false);
    expect(FREE_PROVIDERS.has('openai')).toBe(false);
    expect(FREE_PROVIDERS.has('google')).toBe(false);
    expect(FREE_PROVIDERS.has('openrouter')).toBe(false);
  });
});

describe('pricing_key', () => {
  it('formats as provider:model_id', () => {
    expect(pricing_key('anthropic', 'claude-opus-4-7')).toBe('anthropic:claude-opus-4-7');
  });
});

describe('compute_cost', () => {
  const fixture_sonnet: Pricing = {
    input_per_million: 3.0,
    output_per_million: 15.0,
    cached_input_per_million: 0.3,
    cache_write_per_million: 3.75,
  };

  it('computes full-usage breakdown with cache hits (Sonnet 1500 in / 1000 cached / 200 out)', () => {
    const cost = compute_cost(
      { input_tokens: 1500, cached_input_tokens: 1000, output_tokens: 200 },
      fixture_sonnet,
      'anthropic',
    );
    expect(cost).toBeDefined();
    // fresh input = 1500 - 1000 = 500 → 500 * 3 / 1e6 = 0.0015
    expect(cost?.input_usd).toBe(0.0015);
    // cached = 1000 * 0.3 / 1e6 = 0.0003
    expect(cost?.cached_input_usd).toBe(0.0003);
    // output = 200 * 15 / 1e6 = 0.003
    expect(cost?.output_usd).toBe(0.003);
    // total = 0.0015 + 0.0003 + 0.003 = 0.0048
    expect(cost?.total_usd).toBe(0.0048);
    expect(cost?.currency).toBe('USD');
    expect(cost?.is_estimate).toBe(true);
  });

  it('omits cache fields when the corresponding usage was zero', () => {
    const cost = compute_cost(
      { input_tokens: 1000, output_tokens: 500 },
      { input_per_million: 2.5, output_per_million: 10.0, cached_input_per_million: 1.25 },
      'openai',
    );
    expect(cost).toBeDefined();
    expect(cost?.input_usd).toBe(0.0025);
    expect(cost?.output_usd).toBe(0.005);
    expect(cost?.total_usd).toBe(0.0075);
    expect('cached_input_usd' in (cost as object)).toBe(false);
    expect('cache_write_usd' in (cost as object)).toBe(false);
    expect('reasoning_usd' in (cost as object)).toBe(false);
  });

  it('returns an all-zero breakdown for free providers without pricing', () => {
    const cost = compute_cost(
      { input_tokens: 500, output_tokens: 200 },
      undefined,
      'ollama',
    );
    expect(cost).toEqual({
      total_usd: 0,
      input_usd: 0,
      output_usd: 0,
      currency: 'USD',
      is_estimate: true,
    });
  });

  it('returns undefined for paid providers without pricing', () => {
    const cost = compute_cost(
      { input_tokens: 500, output_tokens: 200 },
      undefined,
      'openrouter',
    );
    expect(cost).toBeUndefined();
  });

  it('rounds to 6 decimal places', () => {
    const cost = compute_cost(
      { input_tokens: 1, output_tokens: 1 },
      { input_per_million: 3.0, output_per_million: 15.0 },
      'anthropic',
    );
    expect(cost?.input_usd).toBe(0.000003);
    expect(cost?.output_usd).toBe(0.000015);
    expect(cost?.total_usd).toBe(0.000018);
  });

  it('rolls reasoning tokens into output_usd when reasoning_per_million is absent', () => {
    const cost = compute_cost(
      { input_tokens: 100, output_tokens: 300, reasoning_tokens: 200 },
      { input_per_million: 2.5, output_per_million: 10.0 },
      'openai',
    );
    expect(cost).toBeDefined();
    // plain output tokens = 300 - 200 = 100 → 100 * 10 / 1e6 = 0.001
    // reasoning = 200 * 10 / 1e6 = 0.002 → folded into output_usd
    // output_usd total = 0.001 + 0.002 = 0.003
    expect(cost?.output_usd).toBe(0.003);
    expect('reasoning_usd' in (cost as object)).toBe(false);
    // total = 0.00025 + 0.003 = 0.00325
    expect(cost?.total_usd).toBe(0.00325);
  });

  it('surfaces reasoning_usd separately when reasoning_per_million is configured', () => {
    const cost = compute_cost(
      { input_tokens: 100, output_tokens: 300, reasoning_tokens: 200 },
      {
        input_per_million: 2.5,
        output_per_million: 10.0,
        reasoning_per_million: 20.0,
      },
      'openai',
    );
    expect(cost?.reasoning_usd).toBe(0.004);
    // plain output = 100 * 10 / 1e6 = 0.001
    expect(cost?.output_usd).toBe(0.001);
    expect(cost?.total_usd).toBe(0.00025 + 0.004 + 0.001);
  });

  it('uses input_per_million when cache_write_per_million is absent', () => {
    const cost = compute_cost(
      { input_tokens: 1000, cache_write_tokens: 500, output_tokens: 100 },
      { input_per_million: 3.0, output_per_million: 15.0 }, // no cache_write rate
      'anthropic',
    );
    // fresh_input = 1000 - 0 - 500 = 500 → 500 * 3 / 1e6 = 0.0015
    // cache_write = 500 * 3 / 1e6 = 0.0015 (falls back to input rate)
    // output = 100 * 15 / 1e6 = 0.0015
    expect(cost?.input_usd).toBe(0.0015);
    expect(cost?.cache_write_usd).toBe(0.0015);
    expect(cost?.output_usd).toBe(0.0015);
    expect(cost?.total_usd).toBe(0.0045);
  });
});
