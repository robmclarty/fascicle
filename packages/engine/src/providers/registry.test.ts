import { describe, expect, it } from 'vitest';
import { get_provider_factory, list_builtin_providers } from './registry.js';
import { provider_not_configured_error } from '../errors.js';

describe('builtin provider registry', () => {
  it('exposes all seven built-in provider factories per spec §5.9', () => {
    expect(list_builtin_providers()).toEqual([
      'anthropic',
      'openai',
      'google',
      'ollama',
      'lmstudio',
      'openrouter',
      'claude_cli',
    ]);
  });

  it('throws provider_not_configured_error for unknown names', () => {
    expect(() => get_provider_factory('nobody')).toThrow(provider_not_configured_error);
  });

  it('returns a factory for each built-in name', () => {
    for (const name of list_builtin_providers()) {
      expect(typeof get_provider_factory(name)).toBe('function');
    }
  });
});
