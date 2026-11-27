import { describe, expect, it } from 'vitest'
import {
  create_bedrock_adapter,
  normalize_bedrock_usage,
  translate_bedrock_cache,
} from '../bedrock.js'
import { engine_config_error } from '../../errors.js'

// The level goes to the AI SDK's own `reasoning`
// option, which @ai-sdk/amazon-bedrock maps per model, and no provider options are built.
describe('bedrock ai_sdk effort translation', () => {
  const adapter = create_bedrock_adapter({ region: 'us-east-1' })
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

  it('reads cache read/write tokens from the v7 nested details', () => {
    // v7 Bedrock usage: inputTokens = input + cacheRead + cacheWrite
    // (cache-inclusive total), granularity only in the nested details.
    const usage = normalize_bedrock_usage({
      input_tokens: 650,
      output_tokens: 120,
      input_token_details: { cached_tokens: 400, cache_creation_input_tokens: 150 },
    })
    expect(usage).toStrictEqual({
      input_tokens: 650,
      output_tokens: 120,
      cached_input_tokens: 400,
      cache_write_tokens: 150,
    })
  })
})

describe('normalize_bedrock_usage one-hour writes', () => {
  const raw = { input_tokens: 650, output_tokens: 120, cache_write_tokens: 150 }

  it('sums the one-hour entries of cacheDetails and leaves the five-minute ones out', () => {
    const usage = normalize_bedrock_usage(raw, {
      bedrock: {
        usage: {
          cacheWriteInputTokens: 150,
          cacheDetails: [
            { ttl: '1h', inputTokens: 100 },
            { ttl: '5m', inputTokens: 30 },
            { ttl: '1h', inputTokens: 20 },
          ],
        },
      },
    })
    expect(usage).toStrictEqual({ ...raw, cache_write_1h_tokens: 120 })
  })

  it('reports zero when the split holds no one-hour entry', () => {
    const usage = normalize_bedrock_usage(raw, {
      bedrock: { usage: { cacheDetails: [{ ttl: '5m', inputTokens: 150 }] } },
    })
    expect(usage).toStrictEqual({ ...raw, cache_write_1h_tokens: 0 })
  })

  it('skips an entry that is not an object or carries no token count', () => {
    const usage = normalize_bedrock_usage(raw, {
      bedrock: { usage: { cacheDetails: [null, 'x', ['1h'], { ttl: '1h' }, { ttl: '1h', inputTokens: '9' }, { ttl: '1h', inputTokens: 7 }] } },
    })
    expect(usage).toStrictEqual({ ...raw, cache_write_1h_tokens: 7 })
  })

  it('leaves the field out when the metadata carries no split', () => {
    const shapes: ReadonlyArray<unknown> = [
      undefined,
      null,
      'x',
      {},
      { bedrock: null },
      { bedrock: {} },
      { bedrock: { usage: null } },
      { bedrock: { usage: { cacheWriteInputTokens: 150 } } },
      { bedrock: { usage: { cacheDetails: { ttl: '1h', inputTokens: 5 } } } },
      { anthropic: { usage: { cacheDetails: [{ ttl: '1h', inputTokens: 5 }] } } },
    ]
    for (const shape of shapes) {
      expect(normalize_bedrock_usage(raw, shape)).toStrictEqual(raw)
    }
  })
})

describe('translate_bedrock_cache', () => {
  it("turns '5m' and '1h' into a cache_control inside additionalModelRequestFields", () => {
    expect(translate_bedrock_cache('5m', undefined)).toStrictEqual({
      bedrock: { additionalModelRequestFields: { cache_control: { type: 'ephemeral' } } },
    })
    expect(translate_bedrock_cache('1h', {})).toStrictEqual({
      bedrock: { additionalModelRequestFields: { cache_control: { type: 'ephemeral', ttl: '1h' } } },
    })
  })

  it("adds nothing for 'off', whatever the caller passed", () => {
    expect(translate_bedrock_cache('off', undefined)).toStrictEqual({})
    expect(
      translate_bedrock_cache('off', { bedrock: { additionalModelRequestFields: { top_k: 5 } } }),
    ).toStrictEqual({})
  })

  it("derives nothing beside a caller's own cache_control", () => {
    for (const cache of ['5m', '1h'] as const) {
      expect(
        translate_bedrock_cache(cache, {
          bedrock: { additionalModelRequestFields: { cache_control: { type: 'ephemeral', ttl: '1h' } } },
        }),
      ).toStrictEqual({})
    }
    // A key that is present counts as set, whatever it holds.
    for (const empty of [null, undefined]) {
      expect(
        translate_bedrock_cache('5m', { bedrock: { additionalModelRequestFields: { cache_control: empty } } }),
      ).toStrictEqual({})
    }
  })

  it("keeps the caller's other fields beside the derived one, and returns no sibling key", () => {
    const fields = { output_config: { effort: 'low' }, top_k: 5 }
    const provider_options = {
      bedrock: { guardrailConfig: { guardrailIdentifier: 'g', guardrailVersion: '1' }, additionalModelRequestFields: fields },
    }
    expect(translate_bedrock_cache('5m', provider_options)).toStrictEqual({
      bedrock: {
        additionalModelRequestFields: {
          output_config: { effort: 'low' },
          top_k: 5,
          cache_control: { type: 'ephemeral' },
        },
      },
    })
    expect(fields).toStrictEqual({ output_config: { effort: 'low' }, top_k: 5 })
  })

  it('writes under amazonBedrock, and reads the fields there, when the caller set that key', () => {
    expect(
      translate_bedrock_cache('1h', {
        amazonBedrock: { additionalModelRequestFields: { top_k: 5 } },
        bedrock: { additionalModelRequestFields: { top_p: 1 } },
      }),
    ).toStrictEqual({
      amazonBedrock: {
        additionalModelRequestFields: { top_k: 5, cache_control: { type: 'ephemeral', ttl: '1h' } },
      },
    })
    expect(translate_bedrock_cache('5m', { amazonBedrock: {} })).toStrictEqual({
      amazonBedrock: { additionalModelRequestFields: { cache_control: { type: 'ephemeral' } } },
    })
    // Only the amazonBedrock entry counts when both are set, so a
    // cache_control under bedrock is one the package never reads.
    expect(
      translate_bedrock_cache('5m', {
        amazonBedrock: {},
        bedrock: { additionalModelRequestFields: { cache_control: { type: 'ephemeral', ttl: '1h' } } },
      }),
    ).toStrictEqual({
      amazonBedrock: { additionalModelRequestFields: { cache_control: { type: 'ephemeral' } } },
    })
  })

  it('writes under bedrock when amazonBedrock is null or undefined, as the package falls through to it', () => {
    for (const empty of [null, undefined]) {
      expect(
        translate_bedrock_cache('5m', { amazonBedrock: empty, bedrock: { additionalModelRequestFields: { top_k: 5 } } }),
      ).toStrictEqual({
        bedrock: { additionalModelRequestFields: { top_k: 5, cache_control: { type: 'ephemeral' } } },
      })
    }
  })

  it('leaves an entry, or fields, that are not a plain object alone', () => {
    for (const junk of ['x', 7, ['a']]) {
      expect(translate_bedrock_cache('5m', { bedrock: junk })).toStrictEqual({})
      expect(translate_bedrock_cache('5m', { amazonBedrock: junk })).toStrictEqual({})
      expect(
        translate_bedrock_cache('5m', { bedrock: { additionalModelRequestFields: junk } }),
      ).toStrictEqual({})
    }
  })

  it('derives the field when the entry or its fields are absent or null', () => {
    const derived = { bedrock: { additionalModelRequestFields: { cache_control: { type: 'ephemeral' } } } }
    expect(translate_bedrock_cache('5m', { bedrock: null })).toStrictEqual(derived)
    expect(translate_bedrock_cache('5m', { bedrock: {} })).toStrictEqual(derived)
    expect(translate_bedrock_cache('5m', { bedrock: { additionalModelRequestFields: null } })).toStrictEqual(derived)
    expect(translate_bedrock_cache('5m', { anthropic: { cacheControl: 'x' } })).toStrictEqual(derived)
  })
})

describe('create_bedrock_adapter', () => {
  it('declares opt-in caching, with translate_bedrock_cache as its hook', () => {
    const adapter = create_bedrock_adapter({ region: 'us-east-1' })
    expect(adapter.prompt_cache).toBe('opt_in')
    expect(adapter.translate_cache).toBe(translate_bedrock_cache)
  })

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
