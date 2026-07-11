import { describe, expect, it, vi } from 'vitest'
import type { ProviderInit } from '../../types.js'
import { create_openai_adapter } from '../openai.js'
import { engine_config_error } from '../../errors.js'

// Capture what build_model hands to the OpenAI SDK. Real-peer integration stays
// covered by openai.test.ts.
const { captured } = vi.hoisted(() => {
  const value: { config: Record<string, unknown> | undefined, model_id: unknown } = {
    config: undefined,
    model_id: undefined,
  }
  return { captured: value }
})
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: (config: Record<string, unknown>) => {
    captured.config = config
    return (model_id: unknown) => {
      captured.model_id = model_id
      return { mock_model: true }
    }
  },
}))

describe('create_openai_adapter config assembly', () => {
  it('is an ai_sdk adapter named openai', () => {
    const adapter = create_openai_adapter({ api_key: 'k' })
    expect(adapter.kind).toBe('ai_sdk')
    expect(adapter.name).toBe('openai')
  })

  it('rejects a missing or non-string api_key with a tagged engine_config_error', () => {
    for (const init of [{ api_key: '' }, {}, { api_key: 123 }]) {
      let err: unknown
      try {
        create_openai_adapter(init as unknown as ProviderInit)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(engine_config_error)
      expect((err as engine_config_error).message).toBe('openai provider requires a non-empty api_key')
      expect((err as engine_config_error).provider).toBe('openai')
    }
  })

  it('forwards apiKey, baseURL, and organization to the SDK', async () => {
    const adapter = create_openai_adapter({
      api_key: 'secret',
      base_url: 'https://oai.example/v1',
      organization: 'org-123',
    })
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    const model = await adapter.build_model('gpt-5-codex')
    expect(model).toBeDefined()
    expect(captured.config).toEqual({
      apiKey: 'secret',
      baseURL: 'https://oai.example/v1',
      organization: 'org-123',
    })
    expect(captured.model_id).toBe('gpt-5-codex')
  })

  it('sends only apiKey when no optional config is given', async () => {
    captured.config = undefined
    const adapter = create_openai_adapter({ api_key: 'secret' })
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    await adapter.build_model('m')
    expect(captured.config).toEqual({ apiKey: 'secret' })
    expect('baseURL' in (captured.config ?? {})).toBe(false)
    expect('organization' in (captured.config ?? {})).toBe(false)
  })

  it('ignores non-string optional config', async () => {
    captured.config = undefined
    const adapter = create_openai_adapter({
      api_key: 'secret',
      base_url: 123,
      organization: true,
    } as unknown as ProviderInit)
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    await adapter.build_model('m')
    expect(captured.config).toEqual({ apiKey: 'secret' })
  })
})
