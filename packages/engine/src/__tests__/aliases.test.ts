import { describe, expect, it } from 'vitest';
import { DEFAULT_ALIASES, resolve_model } from '../aliases.js';
import { model_not_found_error } from '../errors.js';

describe('DEFAULT_ALIASES', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_ALIASES)).toBe(true);
  });

  it('maps short aliases to anthropic claude ids', () => {
    expect(DEFAULT_ALIASES['sonnet']).toEqual({
      provider: 'anthropic',
      model_id: 'claude-sonnet-4-6',
    });
    expect(DEFAULT_ALIASES['opus']).toEqual({
      provider: 'anthropic',
      model_id: 'claude-opus-4-7',
    });
    expect(DEFAULT_ALIASES['haiku']).toEqual({
      provider: 'anthropic',
      model_id: 'claude-haiku-4-5',
    });
  });

  it('ships the or:* openrouter multiplexer aliases', () => {
    expect(DEFAULT_ALIASES['or:sonnet']).toEqual({
      provider: 'openrouter',
      model_id: 'anthropic/claude-sonnet-4.5',
    });
    expect(DEFAULT_ALIASES['or:llama-3.3-70b']).toEqual({
      provider: 'openrouter',
      model_id: 'meta-llama/llama-3.3-70b-instruct',
    });
  });
});

describe('resolve_model', () => {
  it('resolves a default alias', () => {
    expect(resolve_model(DEFAULT_ALIASES, 'sonnet')).toEqual({
      provider: 'anthropic',
      model_id: 'claude-sonnet-4-6',
    });
  });

  it('splits provider:model on the first colon only', () => {
    const openrouter = resolve_model(DEFAULT_ALIASES, 'openrouter:anthropic/claude-sonnet-4.5');
    expect(openrouter).toEqual({
      provider: 'openrouter',
      model_id: 'anthropic/claude-sonnet-4.5',
    });

    const ollama = resolve_model(DEFAULT_ALIASES, 'ollama:gemma3:27b');
    expect(ollama).toEqual({ provider: 'ollama', model_id: 'gemma3:27b' });
  });

  it('bypasses the alias table on colon-form even when the suffix collides with an alias', () => {
    const custom: Record<string, { provider: string; model_id: string }> = {
      ...DEFAULT_ALIASES,
      sonnet: { provider: 'openai', model_id: 'gpt-4o' },
    };
    expect(resolve_model(custom, 'anthropic:claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      model_id: 'claude-sonnet-4-6',
    });
  });

  it('throws model_not_found_error listing registered aliases on miss', () => {
    try {
      resolve_model(DEFAULT_ALIASES, 'nonsense');
      expect.unreachable('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(model_not_found_error);
      const msg = (err as Error).message;
      expect(msg).toContain('nonsense');
      expect(msg).toContain('sonnet');
      expect(msg).toContain('gpt-4o');
    }
  });

  it('treats an unknown provider prefix as a normal alias lookup', () => {
    expect(() => resolve_model(DEFAULT_ALIASES, 'unknown-provider:foo')).toThrow(
      model_not_found_error,
    );
  });
});
