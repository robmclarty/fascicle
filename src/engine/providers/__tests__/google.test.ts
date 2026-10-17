import { describe, expect, it } from 'vitest'
import {
  create_google_adapter,
  normalize_google_usage,
} from '../google.js'
import { engine_config_error } from '../../errors.js'

// D7 (sdk-reasoning-option): the level goes to the AI SDK's own `reasoning`
// option, which @ai-sdk/google maps per model, and no provider options are built.
describe('google ai_sdk effort translation', () => {
  const adapter = create_google_adapter({ api_key: 'secret' })
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

  it('reads cached and reasoning (thoughts) tokens from the v7 nested details', () => {
    // v7 Google usage: inputTokens = promptTokenCount (cache-inclusive),
    // outputTokens = candidates + thoughts, reasoning = thoughtsTokenCount.
    const usage = normalize_google_usage({
      input_tokens: 900,
      output_tokens: 340,
      input_token_details: { cached_tokens: 700 },
      output_token_details: { reasoning_tokens: 90 },
    })
    expect(usage).toStrictEqual({
      input_tokens: 900,
      output_tokens: 340,
      reasoning_tokens: 90,
      cached_input_tokens: 700,
    })
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
