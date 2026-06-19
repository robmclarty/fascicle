import { describe, expect, it, vi } from 'vitest'
import type { ProviderInit } from '../../types.js'
import { create_lmstudio_adapter } from '../lmstudio.js'
import { engine_config_error } from '../../errors.js'

const { captured } = vi.hoisted(() => ({
  captured: { config: undefined as Record<string, unknown> | undefined, model_id: undefined as unknown },
}))
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: (config: Record<string, unknown>) => {
    captured.config = config
    return (model_id: unknown) => {
      captured.model_id = model_id
      return { mock_model: true }
    }
  },
}))

describe('create_lmstudio_adapter config assembly', () => {
  it('is an ai_sdk adapter named lmstudio', () => {
    const adapter = create_lmstudio_adapter({ base_url: 'http://localhost:1234/v1' })
    expect(adapter.kind).toBe('ai_sdk')
    expect(adapter.name).toBe('lmstudio')
  })

  it('rejects a missing or non-string base_url with a tagged engine_config_error', () => {
    for (const init of [{}, { base_url: '' }, { base_url: 123 }]) {
      let err: unknown
      try {
        create_lmstudio_adapter(init as unknown as ProviderInit)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(engine_config_error)
      expect((err as engine_config_error).message).toBe('lmstudio provider requires a non-empty base_url')
      expect((err as engine_config_error).provider).toBe('lmstudio')
    }
  })

  it('forwards the lmstudio name and base URL to the SDK', async () => {
    const adapter = create_lmstudio_adapter({ base_url: 'http://localhost:1234/v1' })
    const model = await adapter.build_model('local-model')
    expect(model).toBeDefined()
    expect(captured.config).toEqual({ name: 'lmstudio', baseURL: 'http://localhost:1234/v1' })
    expect(captured.model_id).toBe('local-model')
  })
})
