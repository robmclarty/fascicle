import { describe, expect, it } from 'vitest'
import {
  create_google_adapter,
  normalize_google_usage,
  translate_google_effort,
} from '../google.js'
import { engine_config_error } from '../../errors.js'

describe('translate_google_effort', () => {
  it('maps none to empty provider options', () => {
    expect(translate_google_effort('none')).toEqual({
      provider_options: {},
      effort_ignored: false,
    })
  })

  it('maps low/medium/high to thinkingConfig.thinkingBudget per spec §6.3', () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      const translated = translate_google_effort(effort)
      expect(
        (translated.provider_options['google'] as {
          thinkingConfig: { thinkingBudget: string }
        }).thinkingConfig.thinkingBudget,
      ).toBe(effort)
      expect(translated.effort_ignored).toBe(false)
    }
  })

  it('clamps xhigh and max to high since Google exposes no level above high', () => {
    for (const effort of ['xhigh', 'max'] as const) {
      const translated = translate_google_effort(effort)
      expect(
        (translated.provider_options['google'] as {
          thinkingConfig: { thinkingBudget: string }
        }).thinkingConfig.thinkingBudget,
      ).toBe('high')
      expect(translated.effort_ignored).toBe(false)
    }
  })
})

describe('normalize_google_usage', () => {
  it('reports input/output tokens and cached_input when present', () => {
    const usage = normalize_google_usage({
      input_tokens: 300,
      output_tokens: 60,
      cached_input_tokens: 200,
    })
    expect(usage.input_tokens).toBe(300)
    expect(usage.output_tokens).toBe(60)
    expect(usage.cached_input_tokens).toBe(200)
  })

  it('strips cache_write_tokens because Google does not report it', () => {
    const usage = normalize_google_usage({
      input_tokens: 300,
      output_tokens: 60,
    })
    expect('cache_write_tokens' in usage).toBe(false)
  })

  it('returns zero-only usage when raw is undefined', () => {
    expect(normalize_google_usage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    })
  })
})

describe('create_google_adapter', () => {
  it('throws engine_config_error when api_key is missing', () => {
    expect(() => create_google_adapter({ api_key: '' })).toThrow(engine_config_error)
  })

  it('supports reasoning, tools, schema, streaming, images', () => {
    const adapter = create_google_adapter({ api_key: 'secret' })
    for (const cap of ['text', 'tools', 'schema', 'streaming', 'image_input', 'reasoning'] as const) {
      expect(adapter.supports(cap)).toBe(true)
    }
  })

  it('build_model returns a value when the @ai-sdk/google peer resolves', async () => {
    const adapter = create_google_adapter({ api_key: 'secret' })
    const model = await adapter.build_model('gemini-2.5-flash')
    expect(model).toBeDefined()
  })
})
