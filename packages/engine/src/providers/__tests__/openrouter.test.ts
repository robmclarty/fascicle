import { describe, expect, it } from 'vitest';
import {
  create_openrouter_adapter,
  normalize_openrouter_usage,
  translate_openrouter_effort,
} from '../openrouter.js';
import { engine_config_error } from '../../errors.js';

describe('translate_openrouter_effort', () => {
  it('maps none to empty provider options', () => {
    expect(translate_openrouter_effort('none')).toEqual({
      provider_options: {},
      effort_ignored: false,
    });
  });

  it('maps low/medium/high to reasoning.effort per spec §6.3', () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      const translated = translate_openrouter_effort(effort);
      expect(
        (translated.provider_options['openrouter'] as { reasoning: { effort: string } })
          .reasoning.effort,
      ).toBe(effort);
      expect(translated.effort_ignored).toBe(false);
    }
  });

  it('forwards xhigh and max verbatim; upstream model decides interpretation', () => {
    for (const effort of ['xhigh', 'max'] as const) {
      const translated = translate_openrouter_effort(effort);
      expect(
        (translated.provider_options['openrouter'] as { reasoning: { effort: string } })
          .reasoning.effort,
      ).toBe(effort);
      expect(translated.effort_ignored).toBe(false);
    }
  });
});

describe('normalize_openrouter_usage', () => {
  it('preserves flat fields including cached/cache-write/reasoning tokens', () => {
    const usage = normalize_openrouter_usage({
      input_tokens: 500,
      output_tokens: 80,
      cached_input_tokens: 300,
      cache_write_tokens: 50,
      reasoning_tokens: 20,
    });
    expect(usage).toEqual({
      input_tokens: 500,
      output_tokens: 80,
      cached_input_tokens: 300,
      cache_write_tokens: 50,
      reasoning_tokens: 20,
    });
  });
});

describe('create_openrouter_adapter', () => {
  it('throws engine_config_error when api_key is missing', () => {
    expect(() => create_openrouter_adapter({ api_key: '' })).toThrow(engine_config_error);
  });

  it('supports reasoning, tools, schema, streaming, images', () => {
    const adapter = create_openrouter_adapter({ api_key: 'secret' });
    for (const cap of ['text', 'tools', 'schema', 'streaming', 'image_input', 'reasoning'] as const) {
      expect(adapter.supports(cap)).toBe(true);
    }
  });

  it('build_model returns a value when the @openrouter/ai-sdk-provider peer resolves', async () => {
    const adapter = create_openrouter_adapter({ api_key: 'secret' });
    const model = await adapter.build_model('anthropic/claude-sonnet-4.5');
    expect(model).toBeDefined();
  });
});
