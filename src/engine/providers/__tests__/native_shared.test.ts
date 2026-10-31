/**
 * native_shared.ts's assistant-part helpers: the filter that keeps a
 * reasoning part only for the provider whose key it carries, and the
 * three-way split the chat-completions and Ollama mappers serialize from.
 * The wire plumbing in the same module is covered through each adapter's own
 * tests, apart from `on_wire`, which every built-in native adapter reaches
 * through `invoke_http_turn` and which is tested here through a real engine,
 * and `error_body_message` and `non_retryable_status_error`, which the
 * engine's ai_sdk classifier also calls.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TrajectoryLogger } from '#core'
import { create_engine } from '../../create_engine.js'
import { provider_auth_error, provider_error } from '../../errors.js'
import type { AssistantContentPart, CapturePayload, EngineConfig } from '../../types.js'
import {
  error_body_message,
  is_own_reasoning,
  network_detail,
  non_retryable_status_error,
  protocol_error,
  split_assistant_parts,
  unreachable_message,
} from '../native_shared.js'

type ReasoningPart = Extract<AssistantContentPart, { type: 'reasoning' }>

const own: ReasoningPart = {
  type: 'reasoning',
  text: 'mine',
  provider_options: { openrouter: { detail: { type: 'reasoning.text', text: 'mine' } } },
}
const foreign: ReasoningPart = {
  type: 'reasoning',
  text: 'theirs',
  provider_options: { anthropic: { signature: 'sig' } },
}
const bare: ReasoningPart = { type: 'reasoning', text: 'no data' }

describe('error_body_message', () => {
  it('reads a string or a { message } under error, then a top-level message', () => {
    expect(error_body_message('{"type":"error","error":{"type":"api_error","message":"Overloaded"}}')).toBe('Overloaded')
    expect(error_body_message('{"error":"model not found"}')).toBe('model not found')
    expect(error_body_message('{"message":"Bedrock is unable to process your request."}')).toBe(
      'Bedrock is unable to process your request.',
    )
  })

  it('prefers the message under error over a top-level one', () => {
    expect(error_body_message('{"error":{"message":"inner"},"message":"outer"}')).toBe('inner')
    expect(error_body_message('{"error":"inner","message":"outer"}')).toBe('inner')
  })

  it('falls back to the top-level message when error carries none', () => {
    for (const error of ['null', '42', '""', '{"code":1}', '{"message":""}']) {
      expect(error_body_message(`{"error":${error},"message":"outer"}`), error).toBe('outer')
    }
  })

  it('returns undefined for a body that is not JSON or carries no message', () => {
    for (const body of ['', '<html>502</html>', '"just a string"', 'null', '{"code":502}', '{"message":""}', '{"message":7}']) {
      expect(error_body_message(body), body).toBeUndefined()
    }
  })
})

describe('non_retryable_status_error', () => {
  it("makes a 401 a provider_auth_error that names the key to check, after the provider's text", () => {
    const err = non_retryable_status_error('openrouter', 401, 'User not found.')
    expect(err).toBeInstanceOf(provider_auth_error)
    expect((err as provider_auth_error).provider).toBe('openrouter')
    expect(err.message).toBe('openrouter authentication failed (401): User not found: check providers.openrouter.api_key')
    expect(err.cause).toBeUndefined()
    const cause = new Error('Unauthorized')
    expect(non_retryable_status_error('anthropic', 401, 'invalid x-api-key', { cause }).cause).toBe(cause)
  })

  it('says a local provider sends no credentials, so a 401 comes from a proxy', () => {
    for (const provider of ['ollama', 'lmstudio']) {
      expect(non_retryable_status_error(provider, 401, 'unauthorized').message, provider).toBe(
        `${provider} authentication failed (401): unauthorized: the ${provider} provider sends no credentials, so check that base_url reaches the server without a proxy that asks for them`,
      )
    }
  })

  it('keeps every period but a closing one', () => {
    expect(non_retryable_status_error('openai', 401, 'cut off...').message).toBe(
      'openai authentication failed (401): cut off...: check providers.openai.api_key',
    )
    expect(non_retryable_status_error('openai', 401, 'key v1.2 revoked').message).toBe(
      'openai authentication failed (401): key v1.2 revoked: check providers.openai.api_key',
    )
  })

  it('makes a 403 a provider_error that says the credentials lack access, keeping status, body, and cause', () => {
    const body = '{"message":"The security token included in the request is invalid."}'
    const cause = new Error('undefined: The security token included in the request is invalid.')
    const err = non_retryable_status_error('bedrock', 403, 'The security token included in the request is invalid.', {
      body,
      cause,
    })
    expect(err).toBeInstanceOf(provider_error)
    expect(err.message).toBe(
      'bedrock API error 403: The security token included in the request is invalid: the credentials lack access to this model or endpoint',
    )
    expect(err).toMatchObject({ status: 403, body, cause })
  })

  it('says to pull a model that Ollama names as missing, in either quote', () => {
    expect(non_retryable_status_error('ollama', 404, 'model "qwen3:4b" not found, try pulling it first').message).toBe(
      'ollama API error 404: model "qwen3:4b" not found, try pulling it first: run ollama pull qwen3:4b',
    )
    expect(non_retryable_status_error('ollama', 404, "model 'nope' not found").message).toBe(
      "ollama API error 404: model 'nope' not found: run ollama pull nope",
    )
  })

  it('says to check the model id and base_url on any other 404', () => {
    expect(non_retryable_status_error('ollama', 404, '404 page not found').message).toBe(
      'ollama API error 404: 404 page not found: check the model id against the ollama model list, and that base_url points at the ollama API',
    )
    // Only Ollama's reply means `ollama pull` will fix it.
    expect(non_retryable_status_error('anthropic', 404, "model 'claude-nope' not found").message).toBe(
      "anthropic API error 404: model 'claude-nope' not found: check the model id against the anthropic model list, and that base_url points at the anthropic API",
    )
  })

  it("leaves any other status at the provider's own text, period and all", () => {
    for (const status of [400, 402, 409, 422]) {
      const err = non_retryable_status_error('openai', status, 'Bad request.', { body: 'raw' })
      expect(err, String(status)).toBeInstanceOf(provider_error)
      expect(err.message, String(status)).toBe(`openai API error ${status}: Bad request.`)
      expect(err, String(status)).toMatchObject({ status, body: 'raw', cause: undefined })
    }
  })
})

describe('network_detail', () => {
  it('adds the code that the error or its cause carries', () => {
    expect(network_detail(Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' }))).toBe(
      'getaddrinfo failed (ENOTFOUND)',
    )
    const refused = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
    expect(network_detail(new TypeError('fetch failed', { cause: refused }))).toBe('fetch failed (ECONNREFUSED)')
    // The error's own code wins over its cause's.
    const both = Object.assign(new Error('x', { cause: refused }), { code: 'UND_ERR_SOCKET' })
    expect(network_detail(both)).toBe('x (UND_ERR_SOCKET)')
  })

  it('adds nothing when the message names the code already, or no code is a string', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' })
    expect(network_detail(new Error('Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434', { cause: refused }))).toBe(
      'Cannot connect to API: connect ECONNREFUSED 127.0.0.1:11434',
    )
    expect(network_detail(new Error('terminated'))).toBe('terminated')
    expect(network_detail(Object.assign(new Error('x'), { code: 7 }))).toBe('x')
    expect(network_detail(new Error('x', { cause: null }))).toBe('x')
    expect(network_detail(new Error('x', { cause: 'ECONNRESET' }))).toBe('x')
  })

  it('names a failure with no message by its code, or says it has no detail', () => {
    const every_address = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' })
    expect(network_detail(every_address)).toBe('ECONNREFUSED')
    expect(network_detail(new TypeError('fetch failed', { cause: every_address }))).toBe('fetch failed (ECONNREFUSED)')
    expect(network_detail(new Error(''))).toBe('(no detail)')
  })

  it('prints a thrown value that is not an Error', () => {
    expect(network_detail('socket closed')).toBe('socket closed')
    expect(network_detail(null)).toBe('null')
    expect(network_detail({ code: 'ECONNRESET' })).toBe('[object Object] (ECONNRESET)')
  })
})

describe('unreachable_message', () => {
  it('names the URL without its credentials, query, or fragment', () => {
    expect(
      unreachable_message('openai', 'https://user:sk-secret@gateway.example:8443/v1/chat/completions?key=sk-q#frag', 'fetch failed'),
    ).toBe(
      'openai could not be reached at https://gateway.example:8443/v1/chat/completions: fetch failed: check base_url, and that the server is running',
    )
    expect(unreachable_message('openai', 'not a url/chat/completions', 'Failed to parse URL')).toBe(
      'openai could not be reached at a base_url that is not a valid URL: Failed to parse URL: check base_url, and that the server is running',
    )
  })

  it("puts the log-safe URL in place of the raw one wherever the failure's own text repeats it", () => {
    const url = 'http://user:sk-secret@localhost:11999/v1?key=q/chat/completions'
    expect(
      unreachable_message('openai', url, `Request cannot be constructed from a URL that includes credentials: ${url}`),
    ).toBe(
      'openai could not be reached at http://localhost:11999/v1: Request cannot be constructed from a URL that includes credentials: http://localhost:11999/v1: check base_url, and that the server is running',
    )
    expect(unreachable_message('openai', 'not a url', 'Failed to parse URL from not a url')).toBe(
      'openai could not be reached at a base_url that is not a valid URL: Failed to parse URL from a base_url that is not a valid URL: check base_url, and that the server is running',
    )
    // An empty URL replaces nothing.
    expect(unreachable_message('openai', '', 'fetch failed')).toBe(
      'openai could not be reached at a base_url that is not a valid URL: fetch failed: check base_url, and that the server is running',
    )
  })

  it('names the URL, the failure, and what to check, with the command that starts Ollama', () => {
    expect(unreachable_message('openai', 'https://api.openai.com/v1/chat/completions', 'fetch failed')).toBe(
      'openai could not be reached at https://api.openai.com/v1/chat/completions: fetch failed: check base_url, and that the server is running',
    )
    expect(unreachable_message('ollama', 'http://localhost:11434/api/chat', 'fetch failed')).toBe(
      'ollama could not be reached at http://localhost:11434/api/chat: fetch failed: check base_url, and that the server is running (ollama serve)',
    )
  })
})

describe('protocol_error', () => {
  it('says what was wrong and to check base_url, with the other fix when there is one', () => {
    const err = protocol_error('openai', 'response has no choices')
    expect(err).toBeInstanceOf(provider_error)
    expect(err.message).toBe('openai native: response has no choices: check that base_url points at the openai API')
    expect(err.status).toBeUndefined()
    expect(protocol_error('openrouter', 'response is missing its usage object', 'use the lmstudio provider').message).toBe(
      'openrouter native: response is missing its usage object: check that base_url points at the openrouter API, or use the lmstudio provider',
    )
  })
})

describe('is_own_reasoning', () => {
  it('keeps a part carrying data under the provider key', () => {
    expect(is_own_reasoning(own, 'openrouter')).toBe(true)
  })

  it('drops a part keyed for another provider', () => {
    expect(is_own_reasoning(foreign, 'openrouter')).toBe(false)
  })

  it('drops a part with no data', () => {
    expect(is_own_reasoning(bare, 'openrouter')).toBe(false)
  })
})

describe('split_assistant_parts', () => {
  it('returns the text runs, the tool calls, and the provider\'s own reasoning, each in order', () => {
    const later: ReasoningPart = {
      type: 'reasoning',
      text: '',
      provider_options: { openrouter: { detail: { type: 'reasoning.encrypted', data: 'e' } } },
    }
    const parts: AssistantContentPart[] = [
      own,
      { type: 'text', text: 'a' },
      foreign,
      { type: 'tool_call', id: 'c1', name: 'search', input: { q: 'x' } },
      bare,
      { type: 'text', text: 'b' },
      later,
    ]
    expect(split_assistant_parts(parts, 'openrouter')).toStrictEqual({
      texts: ['a', 'b'],
      tool_parts: [{ type: 'tool_call', id: 'c1', name: 'search', input: { q: 'x' } }],
      reasoning: [own, later],
    })
  })
})

describe('on_wire, through a real engine with capture: wire', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const SECRET = 'sk-test-wire-secret'

  /** A reply each dialect reads as a whole JSON body. */
  const REPLIES = {
    anthropic: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    },
    chat: {
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    },
    ollama: { message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 1 },
  } as const

  type Sent = { url: string; body: string; headers: Record<string, string> }

  /** Stub fetch with `statuses` (a 200 after them), returning what each request sent. */
  function stub_fetch(reply: unknown, statuses: ReadonlyArray<number> = []): Sent[] {
    const sent: Sent[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        sent.push({
          url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          body: typeof init?.body === 'string' ? init.body : '',
          headers: { ...(init?.headers as Record<string, string>) },
        })
        const status = statuses[sent.length - 1] ?? 200
        return new Response(JSON.stringify(status === 200 ? reply : { error: { message: 'busy' } }), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    return sent
  }

  /** Record every event, stamps left off. */
  function recorder(): { trajectory: TrajectoryLogger; events: Array<Record<string, unknown>> } {
    const events: Array<Record<string, unknown>> = []
    return {
      events,
      trajectory: {
        record: (e) => {
          const { ts: _ts, ...rest } = e
          events.push(rest)
        },
        start_span: (name) => name,
        end_span: () => {},
      },
    }
  }

  const of_kind = (events: Array<Record<string, unknown>>, kind: string): Array<Record<string, unknown>> =>
    events.filter((e) => e['kind'] === kind)

  const CASES: ReadonlyArray<{ provider: string; config: EngineConfig['providers']; reply: unknown }> = [
    { provider: 'anthropic', config: { anthropic: { api_key: SECRET, transport: 'native' } }, reply: REPLIES.anthropic },
    { provider: 'openai', config: { openai: { api_key: SECRET, transport: 'native' } }, reply: REPLIES.chat },
    { provider: 'openrouter', config: { openrouter: { api_key: SECRET, transport: 'native' } }, reply: REPLIES.chat },
    { provider: 'lmstudio', config: { lmstudio: { base_url: 'http://127.0.0.1:1234/v1', transport: 'native' } }, reply: REPLIES.chat },
    { provider: 'ollama', config: { ollama: { base_url: 'http://127.0.0.1:11434', transport: 'native' } }, reply: REPLIES.ollama },
  ]

  it.each(CASES)('$provider records the exact body it sends and the url, and never a header', async ({ provider, config, reply }) => {
    const sent = stub_fetch(reply)
    const { trajectory, events } = recorder()
    const engine = create_engine({ providers: config })
    await engine.generate({ provider, model: 'm', prompt: 'hi', system: 'be brief', capture: 'wire', trajectory })
    const wire = of_kind(events, 'request_wire')
    expect(wire).toStrictEqual([
      {
        kind: 'request_wire',
        step_index: 0,
        span_id: 'engine.generate.step',
        provider,
        url: sent[0]?.url,
        body: JSON.parse(sent[0]?.body ?? ''),
      },
    ])
    expect(JSON.stringify(wire[0]?.['body'])).toBe(sent[0]?.body)
    expect(of_kind(events, 'request_sent')[0]?.['request']).toMatchObject({ messages: [{ role: 'system' }, { role: 'user' }] })
    expect(JSON.stringify(events)).not.toContain(SECRET)
  })

  it("records nothing on the wire under 'turns'", async () => {
    stub_fetch(REPLIES.anthropic)
    const { trajectory, events } = recorder()
    const engine = create_engine({ providers: { anthropic: { api_key: SECRET, transport: 'native' } } })
    await engine.generate({ model: 'm', prompt: 'hi', capture: 'turns', trajectory })
    expect(of_kind(events, 'request_wire')).toStrictEqual([])
    expect(of_kind(events, 'request_sent')[0]).toHaveProperty('request')
  })

  it('records one request_wire per attempt when a turn is retried', async () => {
    const sent = stub_fetch(REPLIES.anthropic, [503])
    const { trajectory, events } = recorder()
    const engine = create_engine({ providers: { anthropic: { api_key: SECRET, transport: 'native' } } })
    await engine.generate({
      model: 'm',
      prompt: 'hi',
      capture: 'wire',
      retry: { max_attempts: 2, initial_delay_ms: 0, max_delay_ms: 0, retry_on: ['provider_5xx'] },
      trajectory,
    })
    expect(sent).toHaveLength(2)
    expect(of_kind(events, 'request_wire').map((e) => e['step_index'])).toStrictEqual([0, 0])
  })

  it('hands the redactor { url, body }, records what it returns, and never changes what goes out', async () => {
    const sent = stub_fetch(REPLIES.anthropic)
    const { trajectory, events } = recorder()
    const seen: CapturePayload[] = []
    const engine = create_engine({
      providers: { anthropic: { api_key: SECRET, transport: 'native' } },
      redact_capture: (payload) => {
        seen.push(payload)
        if (payload.kind !== 'wire') return payload.data
        const data = payload.data as { url: string; body: Record<string, unknown> }
        data.body['model'] = 'scrubbed'
        return { body: data.body }
      },
    })
    await engine.generate({ model: 'm', prompt: 'hi', capture: 'wire', trajectory })
    const wire_payload = seen.find((p) => p.kind === 'wire')
    expect(wire_payload?.step_index).toBe(0)
    expect(Object.keys(wire_payload?.data as object)).toStrictEqual(['url', 'body'])
    expect(JSON.parse(sent[0]?.body ?? '')).toMatchObject({ model: 'm' })
    expect(of_kind(events, 'request_wire')).toStrictEqual([
      {
        kind: 'request_wire',
        step_index: 0,
        span_id: 'engine.generate.step',
        provider: 'anthropic',
        body: { ...JSON.parse(sent[0]?.body ?? ''), model: 'scrubbed' },
      },
    ])
  })

  it('records nothing, and no failure, for a wire payload the redactor drops', async () => {
    stub_fetch(REPLIES.anthropic)
    const { trajectory, events } = recorder()
    const engine = create_engine({
      providers: { anthropic: { api_key: SECRET, transport: 'native' } },
      redact_capture: (payload) => (payload.kind === 'wire' ? undefined : payload.data),
    })
    await engine.generate({ model: 'm', prompt: 'hi', capture: 'wire', trajectory })
    expect(of_kind(events, 'request_wire')).toStrictEqual([])
    expect(of_kind(events, 'capture_redaction_failed')).toStrictEqual([])
  })

  it('fails closed on a wire redactor that returns something other than an object', async () => {
    stub_fetch(REPLIES.anthropic)
    const { trajectory, events } = recorder()
    const engine = create_engine({
      providers: { anthropic: { api_key: SECRET, transport: 'native' } },
      redact_capture: (payload) => (payload.kind === 'wire' ? 'scrubbed' : payload.data),
    })
    await engine.generate({ model: 'm', prompt: 'hi', capture: 'wire', trajectory })
    expect(of_kind(events, 'request_wire')).toStrictEqual([])
    expect(of_kind(events, 'capture_redaction_failed')).toStrictEqual([
      { kind: 'capture_redaction_failed', step_index: 0, span_id: 'engine.generate.step', payload_kind: 'wire' },
    ])
  })
})
