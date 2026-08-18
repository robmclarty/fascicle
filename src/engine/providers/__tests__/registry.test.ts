import { describe, expect, it } from 'vitest'
import { get_provider_factory, list_builtin_providers } from '../registry.js'
import { engine_config_error } from '../../errors.js'

describe('builtin provider registry', () => {
  it('exposes all eight built-in provider factories per spec §5.9', () => {
    expect(list_builtin_providers()).toEqual([
      'anthropic',
      'openai',
      'google',
      'ollama',
      'lmstudio',
      'openrouter',
      'bedrock',
      'claude_cli',
    ])
  })

  it('throws engine_config_error for unknown names, listing the built-ins', () => {
    let err: unknown
    try {
      get_provider_factory('nobody')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(engine_config_error)
    expect((err as engine_config_error).message).toBe(
      "unknown provider 'nobody'; built-in providers are: anthropic, openai, google, ollama, lmstudio, openrouter, bedrock, claude_cli",
    )
    expect((err as engine_config_error).provider).toBe('nobody')
  })

  it('returns a factory for each built-in name', () => {
    for (const name of list_builtin_providers()) {
      expect(typeof get_provider_factory(name)).toBe('function')
    }
  })
})
