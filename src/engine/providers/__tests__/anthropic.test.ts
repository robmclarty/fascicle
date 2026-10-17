import { describe, expect, it } from 'vitest'
import {
  create_anthropic_adapter,
  normalize_anthropic_usage,
} from '../anthropic.js'
import { engine_config_error } from '../../errors.js'

// D7 (sdk-reasoning-option): the level goes to the AI SDK's own `reasoning`
// option, which @ai-sdk/anthropic maps per model, and no provider options are built.
describe('anthropic ai_sdk effort translation', () => {
  const adapter = create_anthropic_adapter({ api_key: 'sk-test' })
  if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'hands %s to the SDK reasoning option with no provider options',
    (level) => {
      expect(adapter.translate_effort(level)).toStrictEqual({
        provider_options: {},
        effort_ignored: false,
        reasoning: level,
      })
    },
  )

  it('sends neither a reasoning level nor provider options for none', () => {
    expect(adapter.translate_effort('none')).toStrictEqual({
      provider_options: {},
      effort_ignored: false,
    })
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
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    const model = await adapter.build_model('claude-opus-4-7')
    expect(model).toBeDefined()
  })
})

describe('transport dispatch', () => {
  it('defaults to the ai_sdk adapter', () => {
    expect(create_anthropic_adapter({ api_key: 'secret' }).kind).toBe('ai_sdk')
  })

  it("returns the ai_sdk adapter for transport: 'ai_sdk'", () => {
    expect(create_anthropic_adapter({ api_key: 'secret', transport: 'ai_sdk' }).kind).toBe(
      'ai_sdk',
    )
  })

  it("returns the native adapter for transport: 'native', keeping the provider name", () => {
    const adapter = create_anthropic_adapter({ api_key: 'secret', transport: 'native' })
    expect(adapter.kind).toBe('native')
    expect(adapter.name).toBe('anthropic')
  })

  it('throws engine_config_error on an unknown transport, tagged with the provider', () => {
    let err: unknown
    try {
      create_anthropic_adapter({ api_key: 'secret', transport: 'grpc' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(engine_config_error)
    expect((err as engine_config_error).message).toBe(
      `anthropic provider: transport must be 'ai_sdk' or 'native', got "grpc"`,
    )
    expect((err as engine_config_error).provider).toBe('anthropic')
  })
})
