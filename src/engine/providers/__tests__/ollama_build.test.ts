import { describe, expect, it, vi } from 'vitest'
import type { ProviderInit } from '../../types.js'
import { create_ollama_adapter } from '../ollama.js'
import { engine_config_error } from '../../errors.js'

const { captured } = vi.hoisted(() => {
  const value: { config: Record<string, unknown> | undefined, model_id: unknown } = {
    config: undefined,
    model_id: undefined,
  }
  return { captured: value }
})
vi.mock('ai-sdk-ollama', () => ({
  createOllama: (config: Record<string, unknown>) => {
    captured.config = config
    return (model_id: unknown) => {
      captured.model_id = model_id
      return { mock_model: true }
    }
  },
}))

describe('create_ollama_adapter config assembly', () => {
  it('is an ai_sdk adapter named ollama', () => {
    const adapter = create_ollama_adapter({ base_url: 'http://localhost:11434' })
    expect(adapter.kind).toBe('ai_sdk')
    expect(adapter.name).toBe('ollama')
  })

  it('rejects a missing or non-string base_url with a tagged engine_config_error', () => {
    for (const init of [{}, { base_url: '' }, { base_url: 123 }]) {
      let err: unknown
      try {
        create_ollama_adapter(init as unknown as ProviderInit)
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(engine_config_error)
      expect((err as engine_config_error).message).toBe('ollama provider requires a non-empty base_url')
      expect((err as engine_config_error).provider).toBe('ollama')
    }
  })

  it('forwards the base URL to the SDK', async () => {
    const adapter = create_ollama_adapter({ base_url: 'http://localhost:11434' })
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    const model = await adapter.build_model('llama3')
    expect(model).toBeDefined()
    expect(captured.config).toEqual({ baseURL: 'http://localhost:11434' })
    expect(captured.model_id).toBe('llama3')
  })
})
