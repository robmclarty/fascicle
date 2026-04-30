import { describe, expect, it } from 'vitest'
import {
  create_ollama_adapter,
  normalize_ollama_usage,
  translate_ollama_effort,
} from '../ollama.js'
import { engine_config_error } from '../../errors.js'

describe('translate_ollama_effort', () => {
  it('drops the field and leaves effort_ignored false when effort is none', () => {
    expect(translate_ollama_effort('none')).toEqual({
      provider_options: {},
      effort_ignored: false,
    })
  })

  it('sets effort_ignored=true for every non-none level (no reasoning support)', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const translated = translate_ollama_effort(effort)
      expect(translated.provider_options).toEqual({})
      expect(translated.effort_ignored).toBe(true)
    }
  })
})

describe('normalize_ollama_usage', () => {
  it('retains only input/output tokens, stripping reasoning and cache fields', () => {
    const usage = normalize_ollama_usage({
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 5,
      cached_input_tokens: 50,
      cache_write_tokens: 10,
    })
    expect(usage).toEqual({ input_tokens: 100, output_tokens: 20 })
  })

  it('returns zero-only usage when raw is undefined', () => {
    expect(normalize_ollama_usage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    })
  })
})

describe('create_ollama_adapter', () => {
  it('throws engine_config_error when base_url is missing', () => {
    expect(() => create_ollama_adapter({})).toThrow(engine_config_error)
  })

  it('supports text/tools/schema/streaming but not image_input or reasoning', () => {
    const adapter = create_ollama_adapter({ base_url: 'http://localhost:11434' })
    expect(adapter.supports('text')).toBe(true)
    expect(adapter.supports('tools')).toBe(true)
    expect(adapter.supports('schema')).toBe(true)
    expect(adapter.supports('streaming')).toBe(true)
    expect(adapter.supports('image_input')).toBe(false)
    expect(adapter.supports('reasoning')).toBe(false)
  })

  it('build_model returns a value when the ai-sdk-ollama peer resolves', async () => {
    const adapter = create_ollama_adapter({ base_url: 'http://localhost:11434' })
    const model = await adapter.build_model('llama3')
    expect(model).toBeDefined()
  })
})
