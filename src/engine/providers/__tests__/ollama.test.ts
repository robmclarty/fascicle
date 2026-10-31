import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  create_ollama_adapter,
  normalize_ollama_usage,
  translate_ollama_effort,
  with_request_facts,
} from '../ollama.js'
import { create_engine } from '../../create_engine.js'
import {
  engine_config_error,
  provider_auth_error,
  provider_error,
  rate_limit_error,
} from '../../errors.js'

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

  it('strips granular fields arriving via the v7 nested details too', () => {
    const usage = normalize_ollama_usage({
      input_tokens: 100,
      output_tokens: 20,
      input_token_details: { cached_tokens: 50, cache_creation_input_tokens: 10 },
      output_token_details: { reasoning_tokens: 5 },
    })
    expect(usage).toStrictEqual({ input_tokens: 100, output_tokens: 20 })
  })
})

describe('create_ollama_adapter', () => {
  it('throws engine_config_error when base_url is missing', () => {
    expect(() => create_ollama_adapter({})).toThrow(engine_config_error)
  })

  it('supports text/tools/schema/streaming/structured_output but not image_input or reasoning', () => {
    const adapter = create_ollama_adapter({ base_url: 'http://localhost:11434' })
    expect(adapter.supports('text')).toBe(true)
    expect(adapter.supports('tools')).toBe(true)
    expect(adapter.supports('schema')).toBe(true)
    expect(adapter.supports('streaming')).toBe(true)
    expect(adapter.supports('structured_output')).toBe(true)
    expect(adapter.supports('image_input')).toBe(false)
    expect(adapter.supports('reasoning')).toBe(false)
  })

  it("build_model returns the package's model, read through for everything but doStream", async () => {
    const adapter = create_ollama_adapter({ base_url: 'http://localhost:11434' })
    if (adapter.kind !== 'ai_sdk') throw new Error('expected the ai_sdk adapter')
    const model = (await adapter.build_model('llama3')) as Record<string, unknown>
    expect(model['modelId']).toBe('llama3')
    expect(model['provider']).toBe('ollama')
    expect(typeof model['doStream']).toBe('function')
  })
})

describe('with_request_facts', () => {
  const URL = 'http://localhost:11434/api/chat'

  it("gives a doStream failure the url, and the status off the ollama client's error", async () => {
    const response_error = Object.assign(new Error('server busy'), { status_code: 503 })
    const failure = new Error('server busy', { cause: response_error })
    const model = with_request_facts({ doStream: async () => Promise.reject(failure) }, URL) as {
      doStream: () => Promise<unknown>
    }
    await expect(model.doStream()).rejects.toBe(failure)
    expect(failure).toMatchObject({ url: URL, statusCode: 503 })
  })

  it('adds only the url when the cause carries no numeric status', async () => {
    const causes: ReadonlyArray<readonly [string, unknown]> = [
      ['an error with no status', new TypeError('fetch failed')],
      ['a status that is a string', { status_code: '503' }],
      ['null', null],
      ['a string', 'boom'],
    ]
    for (const [label, cause] of causes) {
      const failure = new Error('fetch failed', { cause })
      const model = with_request_facts({ doStream: async () => Promise.reject(failure) }, URL) as {
        doStream: () => Promise<unknown>
      }
      await expect(model.doStream(), label).rejects.toBe(failure)
      expect(failure, label).toMatchObject({ url: URL })
      expect('statusCode' in failure, label).toBe(false)
    }
  })

  it('rethrows a value that is not an object as it is', async () => {
    for (const thrown of ['boom', null]) {
      const model = with_request_facts({ doStream: async () => Promise.reject(thrown) }, URL) as {
        doStream: () => Promise<unknown>
      }
      await expect(model.doStream()).rejects.toBe(thrown)
    }
  })

  it("calls the model's own doStream with its arguments and itself as this, and passes a result through", async () => {
    const inner = {
      tag: 'inner',
      async doStream(this: { tag: string }, options: unknown): Promise<unknown> {
        return { tag: this.tag, options }
      },
    }
    const model = with_request_facts(inner, URL) as { doStream: (o: unknown) => Promise<unknown>; tag: string }
    await expect(model.doStream({ prompt: [] })).resolves.toStrictEqual({ tag: 'inner', options: { prompt: [] } })
    expect(model.tag).toBe('inner')
  })

  it('returns a value with no doStream function as it is', () => {
    const plain = { doGenerate: () => undefined }
    expect(with_request_facts(plain, URL)).toBe(plain)
    expect(with_request_facts('model', URL)).toBe('model')
    expect(with_request_facts(null, URL)).toBe(null)
  })
})

describe('ollama on the ai_sdk transport, through the real ai-sdk-ollama', () => {
  const NO_WAIT = {
    max_attempts: 2,
    initial_delay_ms: 0,
    max_delay_ms: 0,
    retry_on: ['rate_limit' as const, 'provider_5xx' as const, 'network' as const],
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Answer every request through `answer`, and count them. */
  function stub_fetch(answer: () => Promise<Response>): () => number {
    const fetch_mock = vi.fn(answer)
    vi.stubGlobal('fetch', fetch_mock)
    return () => fetch_mock.mock.calls.length
  }

  const json = (body: unknown, status: number): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    )

  const generate = (base_url = 'http://localhost:11434/'): Promise<unknown> =>
    create_engine({ providers: { ollama: { base_url } } })
      .generate({ model: 'qwen3:4b', prompt: 'hi', retry: NO_WAIT })
      .catch((e: unknown) => e)

  it('retries a daemon that is not running, and names its URL and how to start it', async () => {
    const every_address = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' })
    const requests = stub_fetch(() => Promise.reject(new TypeError('fetch failed', { cause: every_address })))
    // Every trailing slash goes, as the native transport trims them.
    const err = await generate('http://localhost:11434//')
    expect(err).toBeInstanceOf(provider_error)
    expect(err).toMatchObject({
      cause_kind: 'network',
      attempts: 2,
      message:
        'network after 2 attempts: ollama could not be reached at http://localhost:11434/api/chat: fetch failed (ECONNREFUSED): check base_url, and that the server is running (ollama serve)',
    })
    expect(requests()).toBe(2)
  })

  it('retries a 5xx and a 429, as the other providers do', async () => {
    let requests = stub_fetch(() => json({ error: 'model runner has unexpectedly stopped' }, 500))
    const down = await generate()
    expect(down).toBeInstanceOf(provider_error)
    expect(down).toMatchObject({
      status: 500,
      cause_kind: 'provider_5xx',
      message: 'provider_5xx after 2 attempts (status 500): model runner has unexpectedly stopped',
    })
    expect(requests()).toBe(2)

    vi.unstubAllGlobals()
    requests = stub_fetch(() => json({ error: 'server busy' }, 429))
    const limited = await generate()
    expect(limited).toBeInstanceOf(rate_limit_error)
    expect(limited).toMatchObject({ status: 429, attempts: 2 })
    expect(requests()).toBe(2)
  })

  it('says to pull a model that is missing, and to look past a proxy on a 401, without a retry', async () => {
    let requests = stub_fetch(() => json({ error: "model 'qwen3:4b' not found" }, 404))
    const missing = await generate()
    expect(missing).toBeInstanceOf(provider_error)
    expect(missing).toMatchObject({
      status: 404,
      message: "ollama API error 404: model 'qwen3:4b' not found: run ollama pull qwen3:4b",
    })
    expect((missing as provider_error).cause).toMatchObject({
      url: 'http://localhost:11434/api/chat',
      statusCode: 404,
    })
    expect(requests()).toBe(1)

    vi.unstubAllGlobals()
    requests = stub_fetch(() => json({ error: 'unauthorized' }, 401))
    const proxied = await generate()
    expect(proxied).toBeInstanceOf(provider_auth_error)
    expect((proxied as Error).message).toBe(
      'ollama authentication failed (401): unauthorized: the ollama provider sends no credentials, so check that base_url reaches the server without a proxy that asks for them',
    )
    expect(requests()).toBe(1)
  })

  it('retries a connection that drops mid-stream, and never names it as unreachable', async () => {
    const first = JSON.stringify({ model: 'qwen3:4b', message: { role: 'assistant', content: 'He' }, done: false })
    const requests = stub_fetch(() => {
      const bytes = new TextEncoder().encode(`${first}\n`)
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes)
          controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }))
        },
      })
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
      )
    })
    const err = await generate()
    expect(err).toBeInstanceOf(provider_error)
    expect(err).toMatchObject({ cause_kind: 'network', attempts: 2 })
    expect((err as Error).message).not.toContain('could not be reached')
    expect(requests()).toBe(2)
  })
})
