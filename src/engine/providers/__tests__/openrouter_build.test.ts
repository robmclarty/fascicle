import { describe, expect, it, vi } from 'vitest'
import type { ProviderInit } from '../../types.js'
import { create_openrouter_adapter } from '../openrouter.js'
import { engine_config_error } from '../../errors.js'

// Capture what build_model hands to the OpenRouter SDK so the config assembly
// (api key, base URL, referer/title headers) is observable. The real-peer
// integration stays covered by openrouter.test.ts.
const { captured } = vi.hoisted(() => {
  const value: { config: Record<string, unknown> | undefined, model_id: unknown } = {
    config: undefined,
    model_id: undefined,
  }
  return { captured: value }
})
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: (config: Record<string, unknown>) => {
    captured.config = config
    return (model_id: unknown) => {
      captured.model_id = model_id
      return { mock_model: true }
    }
  },
}))

describe('create_openrouter_adapter config assembly', () => {
  it('is an ai_sdk adapter named openrouter', () => {
    const adapter = create_openrouter_adapter({ api_key: 'k' })
    expect(adapter.kind).toBe('ai_sdk')
    expect(adapter.name).toBe('openrouter')
  })

  it('rejects a missing or non-string api_key with a tagged engine_config_error', () => {
    for (const init of [{ api_key: '' }, {}, { api_key: 123 }]) {
      let err: unknown
      try {
        create_openrouter_adapter(init as unknown as ProviderInit)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(engine_config_error)
      expect((err as engine_config_error).message).toBe(
        'openrouter provider requires a non-empty api_key',
      )
      expect((err as engine_config_error).provider).toBe('openrouter')
    }
  })

  it('forwards apiKey, baseURL, and referer/title headers to the SDK', async () => {
    const adapter = create_openrouter_adapter({
      api_key: 'secret',
      base_url: 'https://or.example/api',
      http_referer: 'https://app.example',
      x_title: 'My App',
    })
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    const model = await adapter.build_model('anthropic/claude-sonnet-4.5')
    expect(model).toBeDefined()
    expect(captured.config).toEqual({
      apiKey: 'secret',
      baseURL: 'https://or.example/api',
      headers: { 'HTTP-Referer': 'https://app.example', 'X-Title': 'My App' },
    })
    expect(captured.model_id).toBe('anthropic/claude-sonnet-4.5')
  })

  it('omits baseURL and headers when no optional config is given', async () => {
    captured.config = undefined
    const adapter = create_openrouter_adapter({ api_key: 'secret' })
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    await adapter.build_model('m')
    expect(captured.config).toEqual({ apiKey: 'secret' })
    // Key absence, not just value: an unconditional `config.baseURL = base_url`
    // would leave a baseURL: undefined entry that toEqual ignores.
    expect('baseURL' in (captured.config ?? {})).toBe(false)
    expect('headers' in (captured.config ?? {})).toBe(false)
  })

  it('sets only the referer header when x_title is absent', async () => {
    captured.config = undefined
    const adapter = create_openrouter_adapter({ api_key: 'secret', http_referer: 'https://app.example' })
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    await adapter.build_model('m')
    expect(captured.config?.['headers']).toEqual({ 'HTTP-Referer': 'https://app.example' })
  })

  it('ignores non-string optional config', async () => {
    captured.config = undefined
    const adapter = create_openrouter_adapter({
      api_key: 'secret',
      base_url: 123,
      http_referer: true,
      x_title: {},
    } as unknown as ProviderInit)
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    await adapter.build_model('m')
    expect(captured.config).toEqual({ apiKey: 'secret' })
  })
})
