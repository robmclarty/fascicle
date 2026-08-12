import { describe, expect, it, vi } from 'vitest'
import type { ProviderInit } from '../../types.js'
import { create_anthropic_adapter } from '../anthropic.js'
import { engine_config_error } from '../../errors.js'

// Capture what build_model hands to the Anthropic SDK so the config assembly
// (api key, base URL) is observable. The real-peer integration stays covered by
// anthropic.test.ts.
const { captured } = vi.hoisted(() => {
  const value: { config: Record<string, unknown> | undefined, model_id: unknown } = {
    config: undefined,
    model_id: undefined,
  }
  return { captured: value }
})
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: (config: Record<string, unknown>) => {
    captured.config = config
    return (model_id: unknown) => {
      captured.model_id = model_id
      return { mock_model: true }
    }
  },
}))

describe('create_anthropic_adapter config assembly', () => {
  it('is an ai_sdk adapter named anthropic', () => {
    const adapter = create_anthropic_adapter({ api_key: 'k' })
    expect(adapter.kind).toBe('ai_sdk')
    expect(adapter.name).toBe('anthropic')
  })

  it('rejects a missing or non-string api_key with a tagged engine_config_error', () => {
    for (const init of [{ api_key: '' }, {}, { api_key: 123 }]) {
      let err: unknown
      try {
        create_anthropic_adapter(init as unknown as ProviderInit)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(engine_config_error)
      expect((err as engine_config_error).message).toBe(
        'anthropic provider requires a non-empty api_key',
      )
      expect((err as engine_config_error).provider).toBe('anthropic')
    }
  })

  it('forwards apiKey and baseURL to the SDK', async () => {
    captured.config = undefined
    const adapter = create_anthropic_adapter({
      api_key: 'secret',
      base_url: 'https://anthropic.example/v1',
    })
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    const model = await adapter.build_model('claude-opus-4-7')
    expect(model).toBeDefined()
    expect(captured.config).toEqual({
      apiKey: 'secret',
      baseURL: 'https://anthropic.example/v1',
    })
    expect(captured.model_id).toBe('claude-opus-4-7')
  })

  it('omits baseURL when no base_url is given', async () => {
    captured.config = undefined
    const adapter = create_anthropic_adapter({ api_key: 'secret' })
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    await adapter.build_model('m')
    expect(captured.config).toEqual({ apiKey: 'secret' })
    // Key absence, not just value: an unconditional `config.baseURL = base_url`
    // would leave a baseURL: undefined entry that toEqual ignores.
    expect('baseURL' in (captured.config ?? {})).toBe(false)
  })

  it('ignores a non-string base_url', async () => {
    captured.config = undefined
    const adapter = create_anthropic_adapter({
      api_key: 'secret',
      base_url: 123,
    } as unknown as ProviderInit)
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    await adapter.build_model('m')
    expect(captured.config).toEqual({ apiKey: 'secret' })
    expect('baseURL' in (captured.config ?? {})).toBe(false)
  })
})
