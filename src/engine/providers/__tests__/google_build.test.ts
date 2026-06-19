import { describe, expect, it, vi } from 'vitest'
import type { ProviderInit } from '../../types.js'
import { create_google_adapter } from '../google.js'
import { engine_config_error } from '../../errors.js'

// Capture what build_model hands to the Google SDK. Real-peer integration stays
// covered by google.test.ts.
const { captured } = vi.hoisted(() => ({
  captured: { config: undefined as Record<string, unknown> | undefined, model_id: undefined as unknown },
}))
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: (config: Record<string, unknown>) => {
    captured.config = config
    return (model_id: unknown) => {
      captured.model_id = model_id
      return { mock_model: true }
    }
  },
}))

describe('create_google_adapter config assembly', () => {
  it('is an ai_sdk adapter named google', () => {
    const adapter = create_google_adapter({ api_key: 'k' })
    expect(adapter.kind).toBe('ai_sdk')
    expect(adapter.name).toBe('google')
  })

  it('rejects a missing or non-string api_key with a tagged engine_config_error', () => {
    for (const init of [{ api_key: '' }, {}, { api_key: 123 }]) {
      let err: unknown
      try {
        create_google_adapter(init as unknown as ProviderInit)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(engine_config_error)
      expect((err as engine_config_error).message).toBe('google provider requires a non-empty api_key')
      expect((err as engine_config_error).provider).toBe('google')
    }
  })

  it('forwards apiKey and baseURL to the SDK', async () => {
    const adapter = create_google_adapter({ api_key: 'secret', base_url: 'https://gen.example' })
    const model = await adapter.build_model('gemini-2.5-pro')
    expect(model).toBeDefined()
    expect(captured.config).toEqual({ apiKey: 'secret', baseURL: 'https://gen.example' })
    expect(captured.model_id).toBe('gemini-2.5-pro')
  })

  it('sends only apiKey when no base_url is given', async () => {
    captured.config = undefined
    const adapter = create_google_adapter({ api_key: 'secret' })
    await adapter.build_model('m')
    expect(captured.config).toEqual({ apiKey: 'secret' })
    expect('baseURL' in (captured.config ?? {})).toBe(false)
  })

  it('ignores a non-string base_url', async () => {
    captured.config = undefined
    const adapter = create_google_adapter({ api_key: 'secret', base_url: 123 } as unknown as ProviderInit)
    await adapter.build_model('m')
    expect(captured.config).toEqual({ apiKey: 'secret' })
  })
})
