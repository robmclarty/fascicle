import { describe, expect, it } from 'vitest'
import {
  create_bedrock_adapter,
  normalize_bedrock_usage,
  translate_bedrock_effort,
} from '../bedrock.js'
import { engine_config_error } from '../../errors.js'

describe('translate_bedrock_effort', () => {
  it('maps none to empty provider options', () => {
    expect(translate_bedrock_effort('none')).toEqual({
      provider_options: {},
      effort_ignored: false,
    })
  })

  it('maps low/medium/high to reasoningConfig.budgetTokens', () => {
    const budgets = { low: 1024, medium: 5000, high: 20000 } as const
    for (const effort of ['low', 'medium', 'high'] as const) {
      const translated = translate_bedrock_effort(effort)
      expect(
        (
          translated.provider_options['bedrock'] as {
            reasoningConfig: { type: string; budgetTokens: number }
          }
        ).reasoningConfig,
      ).toEqual({ type: 'enabled', budgetTokens: budgets[effort] })
      expect(translated.effort_ignored).toBe(false)
    }
  })

  it('raises the ceiling for xhigh and max', () => {
    for (const [effort, budget] of [
      ['xhigh', 32000],
      ['max', 64000],
    ] as const) {
      expect(
        (
          translate_bedrock_effort(effort).provider_options['bedrock'] as {
            reasoningConfig: { budgetTokens: number }
          }
        ).reasoningConfig.budgetTokens,
      ).toBe(budget)
    }
  })
})

describe('normalize_bedrock_usage', () => {
  it('preserves flat fields including cached/cache-write/reasoning tokens', () => {
    const usage = normalize_bedrock_usage({
      input_tokens: 500,
      output_tokens: 80,
      cached_input_tokens: 300,
      cache_write_tokens: 50,
      reasoning_tokens: 20,
    })
    expect(usage).toEqual({
      input_tokens: 500,
      output_tokens: 80,
      cached_input_tokens: 300,
      cache_write_tokens: 50,
      reasoning_tokens: 20,
    })
  })
})

describe('create_bedrock_adapter', () => {
  it('throws engine_config_error when region is missing', () => {
    expect(() => create_bedrock_adapter({})).toThrow(engine_config_error)
  })

  it('supports reasoning, tools, schema, streaming, images', () => {
    const adapter = create_bedrock_adapter({ region: 'us-east-1' })
    for (const cap of [
      'text',
      'tools',
      'schema',
      'streaming',
      'image_input',
      'reasoning',
    ] as const) {
      expect(adapter.supports(cap)).toBe(true)
    }
  })

  it('build_model returns a value when the @ai-sdk/amazon-bedrock peer resolves', async () => {
    const adapter = create_bedrock_adapter({ region: 'us-east-1' })
    const model = await adapter.build_model('anthropic.claude-3-5-sonnet-20241022-v2:0')
    expect(model).toBeDefined()
  })
})
