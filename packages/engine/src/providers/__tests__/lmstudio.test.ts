import { describe, expect, it } from 'vitest'
import {
  create_lmstudio_adapter,
  normalize_lmstudio_usage,
  translate_lmstudio_effort,
} from '../lmstudio.js'
import { engine_config_error } from '../../errors.js'

describe('translate_lmstudio_effort', () => {
  it('drops the field and leaves effort_ignored false when effort is none', () => {
    expect(translate_lmstudio_effort('none')).toEqual({
      provider_options: {},
      effort_ignored: false,
    })
  })

  it('sets effort_ignored=true for every non-none level (no reasoning support)', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const translated = translate_lmstudio_effort(effort)
      expect(translated.provider_options).toEqual({})
      expect(translated.effort_ignored).toBe(true)
    }
  })
})

describe('normalize_lmstudio_usage', () => {
  it('retains only input/output tokens, stripping reasoning and cache fields', () => {
    const usage = normalize_lmstudio_usage({
      input_tokens: 120,
      output_tokens: 25,
      reasoning_tokens: 3,
      cached_input_tokens: 80,
      cache_write_tokens: 5,
    })
    expect(usage).toEqual({ input_tokens: 120, output_tokens: 25 })
  })

  it('returns zero-only usage when raw is undefined', () => {
    expect(normalize_lmstudio_usage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    })
  })
})

describe('create_lmstudio_adapter', () => {
  it('throws engine_config_error when base_url is missing', () => {
    expect(() => create_lmstudio_adapter({})).toThrow(engine_config_error)
  })

  it('supports text/tools/schema/streaming but not image_input or reasoning', () => {
    const adapter = create_lmstudio_adapter({ base_url: 'http://localhost:1234/v1' })
    expect(adapter.supports('text')).toBe(true)
    expect(adapter.supports('tools')).toBe(true)
    expect(adapter.supports('schema')).toBe(true)
    expect(adapter.supports('streaming')).toBe(true)
    expect(adapter.supports('image_input')).toBe(false)
    expect(adapter.supports('reasoning')).toBe(false)
  })

  it('build_model returns a value when the @ai-sdk/openai-compatible peer resolves', async () => {
    const adapter = create_lmstudio_adapter({ base_url: 'http://localhost:1234/v1' })
    const model = await adapter.build_model('local-model')
    expect(model).toBeDefined()
  })
})
