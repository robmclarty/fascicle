import { describe, expect, it } from 'vitest'
import {
  create_openai_adapter,
  normalize_openai_usage,
  translate_openai_effort,
} from '../openai.js'
import { engine_config_error } from '../../errors.js'

describe('translate_openai_effort', () => {
  it('maps none to empty provider options', () => {
    expect(translate_openai_effort('none')).toEqual({
      provider_options: {},
      effort_ignored: false,
    })
  })

  it('maps low/medium/high to the o-series reasoningEffort string per spec §6.3', () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      const translated = translate_openai_effort(effort)
      expect(
        (translated.provider_options['openai'] as { reasoningEffort: string }).reasoningEffort,
      ).toBe(effort)
      expect(translated.effort_ignored).toBe(false)
    }
  })

  it('clamps xhigh and max to high since OpenAI exposes no level above high', () => {
    for (const effort of ['xhigh', 'max'] as const) {
      const translated = translate_openai_effort(effort)
      expect(
        (translated.provider_options['openai'] as { reasoningEffort: string }).reasoningEffort,
      ).toBe('high')
      expect(translated.effort_ignored).toBe(false)
    }
  })
})

describe('normalize_openai_usage', () => {
  it('preserves flat usage fields including cached/reasoning tokens', () => {
    const usage = normalize_openai_usage({
      input_tokens: 200,
      output_tokens: 40,
      cached_input_tokens: 150,
      reasoning_tokens: 12,
    })
    expect(usage).toEqual({
      input_tokens: 200,
      output_tokens: 40,
      cached_input_tokens: 150,
      reasoning_tokens: 12,
    })
  })

  it('reads nested details when flat fields are absent', () => {
    const usage = normalize_openai_usage({
      input_tokens: 100,
      output_tokens: 20,
      input_token_details: { cached_tokens: 75 },
      output_token_details: { reasoning_tokens: 8 },
    })
    expect(usage.cached_input_tokens).toBe(75)
    expect(usage.reasoning_tokens).toBe(8)
  })
})

describe('create_openai_adapter', () => {
  it('throws engine_config_error when api_key is missing', () => {
    expect(() => create_openai_adapter({ api_key: '' })).toThrow(engine_config_error)
  })

  it('supports text, tools, schema, streaming, image_input, reasoning', () => {
    const adapter = create_openai_adapter({ api_key: 'secret' })
    for (const cap of ['text', 'tools', 'schema', 'streaming', 'image_input', 'reasoning'] as const) {
      expect(adapter.supports(cap)).toBe(true)
    }
  })

  it('build_model returns a value when the @ai-sdk/openai peer resolves', async () => {
    const adapter = create_openai_adapter({ api_key: 'secret' })
    const model = await adapter.build_model('gpt-5-codex')
    expect(model).toBeDefined()
  })
})
