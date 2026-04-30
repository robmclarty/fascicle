/**
 * Unit tests for create_engine.
 */

import { describe, expect, it } from 'vitest'
import { create_engine } from '../create_engine.js'
import {
  engine_config_error,
  model_not_found_error,
  provider_not_configured_error,
} from '../errors.js'

describe('create_engine', () => {
  it('rejects an empty Anthropic api_key at construction', () => {
    expect(() =>
      create_engine({ providers: { anthropic: { api_key: '' } } }),
    ).toThrow(engine_config_error)
  })

  it('returns an Engine with default aliases and pricing merged under user overrides', () => {
    const engine = create_engine({
      providers: { anthropic: { api_key: 'k' } },
      aliases: { my_cheap: { provider: 'anthropic', model_id: 'claude-haiku-4-5' } },
      pricing: { 'custom:model-x': { input_per_million: 1, output_per_million: 2 } },
    })
    expect(engine.resolve_alias('sonnet')).toEqual({
      provider: 'anthropic',
      model_id: 'claude-sonnet-4-6',
    })
    expect(engine.resolve_alias('my_cheap')).toEqual({
      provider: 'anthropic',
      model_id: 'claude-haiku-4-5',
    })
    expect(engine.resolve_price('custom', 'model-x')).toEqual({
      input_per_million: 1,
      output_per_million: 2,
    })
    expect(engine.resolve_price('anthropic', 'claude-opus-4-7')).toBeDefined()
  })

  it('register_alias / unregister_alias mutate the per-engine table only', () => {
    const a = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    const b = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    a.register_alias('mine', { provider: 'anthropic', model_id: 'claude-opus-4-7' })
    expect(a.resolve_alias('mine').model_id).toBe('claude-opus-4-7')
    expect(() => b.resolve_alias('mine')).toThrow(model_not_found_error)
    a.unregister_alias('mine')
    expect(() => a.resolve_alias('mine')).toThrow(model_not_found_error)
  })

  it('list_aliases and list_prices return defensive copies', () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    const aliases_before = engine.list_aliases() as Record<
      string,
      { provider: string; model_id: string }
    >
    aliases_before['injected'] = { provider: 'x', model_id: 'y' }
    expect(() => engine.resolve_alias('injected')).toThrow(model_not_found_error)

    const prices_before = engine.list_prices() as Record<
      string,
      { input_per_million: number; output_per_million: number }
    >
    prices_before['custom:z'] = { input_per_million: 99, output_per_million: 99 }
    expect(engine.resolve_price('custom', 'z')).toBeUndefined()
  })

  it('throws provider_not_configured_error at generate time for an unconfigured provider', async () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    await expect(engine.generate({ model: 'gpt-4o', prompt: 'hi' })).rejects.toBeInstanceOf(
      provider_not_configured_error,
    )
  })

  it('throws model_not_found_error before any provider lookup', async () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    await expect(engine.generate({ model: 'nonsense', prompt: 'hi' })).rejects.toBeInstanceOf(
      model_not_found_error,
    )
  })

  it('two engines maintain independent alias tables', () => {
    const a = create_engine({ providers: { anthropic: { api_key: 'a' } } })
    const b = create_engine({ providers: { anthropic: { api_key: 'b' } } })
    a.register_alias('shared', { provider: 'anthropic', model_id: 'claude-opus-4-7' })
    b.register_alias('shared', { provider: 'anthropic', model_id: 'claude-haiku-4-5' })
    expect(a.resolve_alias('shared').model_id).toBe('claude-opus-4-7')
    expect(b.resolve_alias('shared').model_id).toBe('claude-haiku-4-5')
  })

  it('register_price overrides default pricing', () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    engine.register_price('anthropic', 'claude-opus-4-7', {
      input_per_million: 0,
      output_per_million: 0,
    })
    expect(engine.resolve_price('anthropic', 'claude-opus-4-7')).toEqual({
      input_per_million: 0,
      output_per_million: 0,
    })
  })

  describe('defaults', () => {
    it('throws engine_config_error when neither opts.model nor defaults.model is set', async () => {
      const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } })
      await expect(engine.generate({ prompt: 'hi' })).rejects.toBeInstanceOf(
        engine_config_error,
      )
    })
  
    it('uses defaults.model when opts.model is omitted', async () => {
      const engine = create_engine({
        providers: { anthropic: { api_key: 'k' } },
        defaults: { model: 'definitely-not-a-real-alias' },
      })
      // If the default was used, model resolution happens and throws model_not_found_error.
      // If the default was ignored, engine_config_error would be thrown instead.
      await expect(engine.generate({ prompt: 'hi' })).rejects.toBeInstanceOf(
        model_not_found_error,
      )
    })
  
    it('per-call opts.model wins over defaults.model', async () => {
      const engine = create_engine({
        providers: { anthropic: { api_key: 'k' } },
        defaults: { model: 'nonexistent-default' },
      })
      // opts.model is a recognized alias that resolves to anthropic; since no
      // real network call happens here we just confirm resolution didn't fall
      // back to the default (which would have thrown model_not_found_error
      // for 'nonexistent-default'). We use an unknown provider prefix so it
      // throws provider_not_configured_error instead.
      await expect(
        engine.generate({ model: 'gpt-4o', prompt: 'hi' }),
      ).rejects.toBeInstanceOf(provider_not_configured_error)
    })
  
    it('defaults.retry_policy layers as the fallback over legacy default_retry', () => {
      const custom_retry = {
        max_attempts: 7,
        initial_delay_ms: 100,
        max_delay_ms: 500,
        retry_on: ['rate_limit' as const],
      }
      // Smoke: constructing the engine should not throw with both forms set.
      expect(() =>
        create_engine({
          providers: { anthropic: { api_key: 'k' } },
          defaults: { retry_policy: custom_retry },
          default_retry: {
            max_attempts: 2,
            initial_delay_ms: 10,
            max_delay_ms: 20,
            retry_on: ['network' as const],
          },
        }),
      ).not.toThrow()
    })
  })
})
