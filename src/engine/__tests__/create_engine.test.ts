/**
 * Unit tests for create_engine.
 */

import { describe, expect, it } from 'vitest'
import { create_engine } from '../create_engine.js'
import {
  engine_config_error,
  model_required_error,
  provider_not_configured_error,
} from '../errors.js'

describe('create_engine', () => {
  it('rejects an empty Anthropic api_key at construction', () => {
    expect(() =>
      create_engine({ providers: { anthropic: { api_key: '' } } }),
    ).toThrow(engine_config_error)
  })

  it('merges user pricing over the defaults', () => {
    const engine = create_engine({
      providers: { anthropic: { api_key: 'k' } },
      pricing: { 'custom:model-x': { input_per_million: 1, output_per_million: 2 } },
    })
    expect(engine.resolve_price('custom', 'model-x')).toEqual({
      input_per_million: 1,
      output_per_million: 2,
    })
    expect(engine.resolve_price('anthropic', 'claude-opus-4-8')).toBeDefined()
  })

  it('list_prices returns a defensive copy', () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    const prices_before = engine.list_prices() as Record<
      string,
      { input_per_million: number; output_per_million: number }
    >
    prices_before['custom:z'] = { input_per_million: 99, output_per_million: 99 }
    expect(engine.resolve_price('custom', 'z')).toBeUndefined()
  })

  it('throws provider_not_configured_error at generate time for an unconfigured provider', async () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    await expect(
      engine.generate({ model: 'gpt-4o', provider: 'openai', prompt: 'hi' }),
    ).rejects.toBeInstanceOf(provider_not_configured_error)
  })

  it('passes any model id straight through to the chosen provider', async () => {
    const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } })
    // The model string is opaque; it rides through to the (here unconfigured)
    // provider, which surfaces provider_not_configured_error before any call.
    await expect(
      engine.generate({ model: 'mystery-model-x', provider: 'openai', prompt: 'hi' }),
    ).rejects.toBeInstanceOf(provider_not_configured_error)
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
    it('throws model_required_error when no model is given and no default is set', async () => {
      const engine = create_engine({ providers: { anthropic: { api_key: 'k' } } })
      await expect(engine.generate({ prompt: 'hi' })).rejects.toBeInstanceOf(
        model_required_error,
      )
    })

    it('applies defaults.model and defaults.provider when the call omits them', async () => {
      const engine = create_engine({
        providers: { anthropic: { api_key: 'k' } },
        defaults: { model: 'some-model', provider: 'openai' },
      })
      // Reaching provider_not_configured_error (not model_required_error) proves
      // both defaults landed: the model default avoided the required-model throw,
      // and the provider default routed to the unconfigured 'openai'.
      await expect(engine.generate({ prompt: 'hi' })).rejects.toBeInstanceOf(
        provider_not_configured_error,
      )
    })

    it('per-call model/provider win over defaults', async () => {
      const engine = create_engine({
        providers: { anthropic: { api_key: 'k' } },
        defaults: { model: 'some-model', provider: 'anthropic' },
      })
      await expect(
        engine.generate({ model: 'gpt-4o', provider: 'openai', prompt: 'hi' }),
      ).rejects.toBeInstanceOf(provider_not_configured_error)
    })

    it('rejects a defaults.max_tool_calls_per_step below 1 at construction', () => {
      expect(() =>
        create_engine({
          providers: { anthropic: { api_key: 'k' } },
          defaults: { max_tool_calls_per_step: 0 },
        }),
      ).toThrow(engine_config_error)
    })

    it('rejects a negative defaults.tool_call_repair_attempts at construction', () => {
      expect(() =>
        create_engine({
          providers: { anthropic: { api_key: 'k' } },
          defaults: { tool_call_repair_attempts: -1 },
        }),
      ).toThrow(engine_config_error)
    })

    it('accepts valid salvage and clamp defaults', () => {
      expect(() =>
        create_engine({
          providers: { anthropic: { api_key: 'k' } },
          defaults: { tool_call_repair_attempts: 2, max_tool_calls_per_step: 1 },
        }),
      ).not.toThrow()
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
