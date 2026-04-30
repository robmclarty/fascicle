import { describe, expect, it } from 'vitest'
import {
  create_anthropic_adapter,
  normalize_anthropic_usage,
  translate_anthropic_effort,
} from '../anthropic.js'
import { engine_config_error } from '../../errors.js'

describe('translate_anthropic_effort', () => {
  it('maps none to empty provider options without ignoring', () => {
    expect(translate_anthropic_effort('none')).toEqual({
      provider_options: {},
      effort_ignored: false,
    })
  })

  it('maps low/medium/high to Anthropic thinking budget tokens per spec §6.3', () => {
    const low = translate_anthropic_effort('low')
    expect(
      (low.provider_options['anthropic'] as { thinking: { budget_tokens: number } }).thinking
        .budget_tokens,
    ).toBe(1024)
    const medium = translate_anthropic_effort('medium')
    expect(
      (medium.provider_options['anthropic'] as { thinking: { budget_tokens: number } }).thinking
        .budget_tokens,
    ).toBe(5000)
    const high = translate_anthropic_effort('high')
    expect(
      (high.provider_options['anthropic'] as { thinking: { budget_tokens: number } }).thinking
        .budget_tokens,
    ).toBe(20000)
  })

  it('maps xhigh and max to higher budget tokens per CLI ceilings', () => {
    const xhigh = translate_anthropic_effort('xhigh')
    expect(
      (xhigh.provider_options['anthropic'] as { thinking: { budget_tokens: number } }).thinking
        .budget_tokens,
    ).toBe(32000)
    const max = translate_anthropic_effort('max')
    expect(
      (max.provider_options['anthropic'] as { thinking: { budget_tokens: number } }).thinking
        .budget_tokens,
    ).toBe(64000)
  })
})

describe('normalize_anthropic_usage', () => {
  it('preserves flattened cache fields', () => {
    const usage = normalize_anthropic_usage({
      input_tokens: 1500,
      cached_input_tokens: 1000,
      cache_write_tokens: 200,
      output_tokens: 50,
    })
    expect(usage).toEqual({
      input_tokens: 1500,
      output_tokens: 50,
      cached_input_tokens: 1000,
      cache_write_tokens: 200,
    })
  })

  it('reads input_token_details when flattened fields are absent', () => {
    const usage = normalize_anthropic_usage({
      input_tokens: 1500,
      output_tokens: 50,
      input_token_details: { cached_tokens: 1000, cache_creation_input_tokens: 200 },
    })
    expect(usage.cached_input_tokens).toBe(1000)
    expect(usage.cache_write_tokens).toBe(200)
  })
})

describe('create_anthropic_adapter', () => {
  it('throws engine_config_error when api_key is missing', () => {
    expect(() => create_anthropic_adapter({ api_key: '' })).toThrow(engine_config_error)
  })

  it('supports reasoning, tools, schema, streaming, images', () => {
    const adapter = create_anthropic_adapter({ api_key: 'secret' })
    for (const cap of ['text', 'tools', 'schema', 'streaming', 'image_input', 'reasoning'] as const) {
      expect(adapter.supports(cap)).toBe(true)
    }
  })

  it('build_model returns a value when the @ai-sdk/anthropic peer resolves', async () => {
    const adapter = create_anthropic_adapter({ api_key: 'secret' })
    const model = await adapter.build_model('claude-opus-4-7')
    expect(model).toBeDefined()
  })
})
