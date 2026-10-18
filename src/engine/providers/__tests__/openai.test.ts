import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  create_openai_adapter,
  normalize_openai_usage,
} from '../openai.js'
import { engine_config_error } from '../../errors.js'
import { resolve_transport } from '../types.js'

// The level goes to the AI SDK's own `reasoning`
// option, which @ai-sdk/openai maps per model, and no provider options are built.
describe('openai ai_sdk effort translation', () => {
  const adapter = create_openai_adapter({ api_key: 'secret' })
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
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    const model = await adapter.build_model('gpt-5-codex')
    expect(model).toBeDefined()
  })
})

describe('openai transport selection and native wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads an unset transport as ai_sdk', () => {
    expect(resolve_transport({}, 'openai')).toBe('ai_sdk')
    expect(resolve_transport({ transport: 'ai_sdk' }, 'openai')).toBe('ai_sdk')
  })

  it('names the provider when the transport is unknown', () => {
    expect(() => create_openai_adapter({ api_key: 'secret', transport: 'grpc' })).toThrow(
      `openai provider: transport must be 'ai_sdk' or 'native', got "grpc"`,
    )
  })

  /** Run one native turn against a stubbed response and return the request headers. */
  async function native_turn(
    init: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const mock = vi.fn(async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', mock)
    const adapter = create_openai_adapter({ api_key: 'secret', transport: 'native', ...init })
    if (adapter.kind !== 'native') throw new Error('expected the native adapter')
    await adapter.invoke_turn({
      step_index: 0,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      abort: new AbortController().signal,
      stream: false,
      model_id: 'gpt-test',
      effort: 'none',
    })
    const call = mock.mock.calls[0] as unknown as [string, RequestInit]
    return call[1].headers as Record<string, string>
  }

  const OK = {
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }

  it('ignores an organization that is not a string', async () => {
    const headers = await native_turn({ organization: 42 }, OK)
    expect(headers).not.toHaveProperty('OpenAI-Organization')
  })

  it('treats a native response without usage as broken (strict usage)', async () => {
    await expect(native_turn({}, { ...OK, usage: undefined })).rejects.toThrow(
      'openai native: response is missing its usage object',
    )
  })
})
