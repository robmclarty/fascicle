import { describe, expect, it } from 'vitest'
import type { GenerateOptions, GenerateResult, Message } from '../types.js'
import {
  aggregate_cost,
  build_initial_messages,
  classify_provider_error,
  last_provider_reported,
  split_leading_system_messages,
} from '../generate.js'
import { round6 } from '../pricing.js'
import { retry_with_policy } from '../retry.js'

const opts = (o: Partial<GenerateOptions>): GenerateOptions => o as GenerateOptions

describe('build_initial_messages', () => {
  it('prepends a non-empty system message before a string prompt', () => {
    expect(build_initial_messages(opts({ system: 'be brief', prompt: 'hi' }))).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('omits an empty system message', () => {
    expect(build_initial_messages(opts({ system: '', prompt: 'hi' }))).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('copies an array prompt without aliasing', () => {
    const prompt: Message[] = [{ role: 'user', content: 'a' }]
    const out = build_initial_messages(opts({ prompt }))
    expect(out).toEqual(prompt)
    expect(out[0]).not.toBe(prompt[0])
  })
})

describe('classify_provider_error', () => {
  it('passes through non-objects and every already-classified kind', () => {
    expect(classify_provider_error('boom')).toBe('boom')
    expect(classify_provider_error(null)).toBe(null)
    // A conflicting statusCode would re-classify if the kind passthrough failed,
    // so toBe(same ref) proves the already-classified short-circuit wins.
    for (const kind of ['rate_limit', 'provider_5xx', 'network', 'timeout']) {
      const classified = { kind, statusCode: 429, code: 'ECONNRESET' }
      expect(classify_provider_error(classified)).toBe(classified)
    }
  })

  it('does not treat an unknown kind string as already-classified', () => {
    const out = classify_provider_error({ kind: 'mystery', statusCode: 429 }) as { kind?: string }
    expect(out.kind).toBe('rate_limit')
  })

  it('classifies a 429 with no headers and omits absent message/retry_after', () => {
    const out = classify_provider_error({ statusCode: 429 }) as Record<string, unknown>
    expect(out).toEqual({ kind: 'rate_limit', status: 429 })
    expect('message' in out).toBe(false)
    expect('retry_after_ms' in out).toBe(false)
  })

  it('treats 500 and 599 as 5xx but not 600 or 499', () => {
    expect((classify_provider_error({ status: 500 }) as { kind?: string }).kind).toBe('provider_5xx')
    expect((classify_provider_error({ status: 599 }) as { kind?: string }).kind).toBe('provider_5xx')
    const at600 = { status: 600 }
    expect(classify_provider_error(at600)).toBe(at600) // not 5xx -> passthrough
    const at499 = { status: 499 }
    expect(classify_provider_error(at499)).toBe(at499)
  })

  it('classifies a 429 with Retry-After header into rate_limit', () => {
    const out = classify_provider_error({
      statusCode: 429,
      message: 'slow down',
      responseHeaders: { 'retry-after': '2' },
    }) as Record<string, unknown>
    expect(out).toMatchObject({ kind: 'rate_limit', status: 429, message: 'slow down', retry_after_ms: 2000 })
  })

  it('reads the alternate status field and classifies 5xx', () => {
    const out = classify_provider_error({ status: 503, message: 'unavailable' }) as Record<string, unknown>
    expect(out).toMatchObject({ kind: 'provider_5xx', status: 503, message: 'unavailable' })
  })

  it('omits message for a 5xx error that has none', () => {
    expect(classify_provider_error({ status: 500 })).toStrictEqual({ kind: 'provider_5xx', status: 500 })
  })

  it('ignores a non-string Retry-After header', () => {
    const out = classify_provider_error({
      statusCode: 429,
      responseHeaders: { 'retry-after': 2 },
    }) as Record<string, unknown>
    expect('retry_after_ms' in out).toBe(false)
  })

  it('classifies known network error codes', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED']) {
      const out = classify_provider_error({ code, message: 'net' }) as Record<string, unknown>
      expect(out).toMatchObject({ kind: 'network', message: 'net' })
    }
  })

  it('reads a 5xx Retry-After header into retry_after_ms', () => {
    expect(
      classify_provider_error({
        statusCode: 503,
        message: 'overloaded',
        responseHeaders: { 'retry-after': '2' },
      }),
    ).toStrictEqual({ kind: 'provider_5xx', status: 503, message: 'overloaded', retry_after_ms: 2000 })
  })

  it("classifies undici's codes and ECONNRESET, on the error and on its cause, as network", () => {
    for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET']) {
      expect(classify_provider_error({ code, message: 'net' }), code).toStrictEqual({
        kind: 'network',
        message: 'net',
      })
      // The AI SDK's APICallError for a failed fetch keeps undici's error as its cause.
      const wrapped = new Error('Cannot connect to API: Headers Timeout Error', {
        cause: Object.assign(new Error('Headers Timeout Error'), { code }),
      })
      expect(classify_provider_error(wrapped), `cause ${code}`).toStrictEqual({
        kind: 'network',
        message: 'Cannot connect to API: Headers Timeout Error',
      })
    }

    // A cause with no network code, or none at all, leaves the error alone.
    const plain = new Error('boom', { cause: new Error('inner') })
    expect(classify_provider_error(plain)).toBe(plain)
    const coded = new Error('boom', { cause: Object.assign(new Error('inner'), { code: 'EACCES' }) })
    expect(classify_provider_error(coded)).toBe(coded)
    const primitive = new Error('boom', { cause: 'ECONNRESET' })
    expect(classify_provider_error(primitive)).toBe(primitive)
    const nulled = new Error('boom', { cause: null })
    expect(classify_provider_error(nulled)).toBe(nulled)
  })

  it('retries each of those failures, on the error or wrapped in its cause', async () => {
    for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET']) {
      const coded = Object.assign(new Error('other side closed'), { code })
      const failures = [coded, new Error('Cannot connect to API: other side closed', { cause: coded })]
      let attempts = 0
      const result = await retry_with_policy(
        async () => {
          attempts += 1
          const failure = failures[attempts - 1]
          if (failure !== undefined) throw classify_provider_error(failure)
          return 'ok'
        },
        { max_attempts: 3, initial_delay_ms: 0, max_delay_ms: 0, retry_on: ['network'] },
      )
      expect(result, code).toBe('ok')
      expect(attempts, code).toBe(3)
    }
  })

  it('omits message for a network error that has none', () => {
    expect(classify_provider_error({ code: 'ECONNRESET' })).toStrictEqual({ kind: 'network' })
  })

  it('passes through an unclassifiable error object', () => {
    const err = { statusCode: 400, message: 'bad request' }
    expect(classify_provider_error(err)).toBe(err)
  })
})

describe('split_leading_system_messages', () => {
  it('returns the list untouched (no system key) when there is no leading system run', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'mid-conversation system' },
    ]
    const out = split_leading_system_messages(messages)
    // system_parts is empty, so the early guard returns the original list; a
    // dropped guard would emit system:'' and hoist nothing.
    expect('system' in out).toBe(false)
    expect(out.messages).toEqual(messages)
  })

  it('returns the list untouched when every message is system (hoisting would empty messages)', () => {
    const messages: Message[] = [
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
    ]
    const out = split_leading_system_messages(messages)
    // rest is empty, so the guard (|| not &&) fires and nothing is hoisted;
    // both parts of the OR and the guard block are exercised here.
    expect('system' in out).toBe(false)
    expect(out.messages).toEqual(messages)
  })

  it('hoists a leading system run and returns the remaining messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
      { role: 'user', content: 'hi' },
    ]
    const out = split_leading_system_messages(messages)
    // Exact join separator ('\n\n') and the full two-message run: a -= 1 loop
    // step or a '' separator would change this value.
    expect(out.system).toBe('a\n\nb')
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('stops the leading run at the first non-system message', () => {
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'later' },
    ]
    const out = split_leading_system_messages(messages)
    expect(out.system).toBe('sys')
    expect(out.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'later' },
    ])
  })
})

const step = (cost: GenerateResult['steps'][number]['cost']): GenerateResult['steps'][number] =>
  ({ index: 0, text: '', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 }, finish_reason: 'stop', ...(cost !== undefined ? { cost } : {}) })

describe('round6 and aggregate_cost', () => {
  it('rounds to six decimal places', () => {
    expect(round6(0.123456789)).toBe(0.123457)
  })

  it('sums step costs including optional cached/cache_write/reasoning fields', () => {
    const out = aggregate_cost(
      [
        step({ total_usd: 0.1, input_usd: 0.06, output_usd: 0.04, currency: 'USD', is_estimate: true, cached_input_usd: 0.01, cache_write_usd: 0.005, reasoning_usd: 0.02 }),
        step({ total_usd: 0.2, input_usd: 0.12, output_usd: 0.08, currency: 'USD', is_estimate: true, cached_input_usd: 0.03 }),
      ],
      'anthropic',
    )
    expect(out).toMatchObject({
      total_usd: 0.3,
      input_usd: 0.18,
      output_usd: 0.12,
      currency: 'USD',
      cached_input_usd: 0.04,
      cache_write_usd: 0.005,
      reasoning_usd: 0.02,
    })
  })

  it('omits optional cost fields no step reported', () => {
    const out = aggregate_cost([step({ total_usd: 0.1, input_usd: 0.06, output_usd: 0.04, currency: 'USD', is_estimate: true })], 'anthropic')
    expect('cached_input_usd' in (out ?? {})).toBe(false)
    expect('cache_write_usd' in (out ?? {})).toBe(false)
    expect('reasoning_usd' in (out ?? {})).toBe(false)
  })

  it('returns undefined when no step has a cost and the provider is paid', () => {
    expect(aggregate_cost([step(undefined)], 'anthropic')).toBeUndefined()
  })

  it('returns a zero USD estimate for a free provider with steps but no cost', () => {
    expect(aggregate_cost([step(undefined)], 'ollama')).toMatchObject({
      total_usd: 0,
      currency: 'USD',
      is_estimate: true,
    })
  })

  it('returns undefined for a free provider with no steps at all', () => {
    expect(aggregate_cost([], 'ollama')).toBeUndefined()
  })
})

describe('last_provider_reported', () => {
  const reported_step = (
    index: number,
    provider_reported?: Record<string, unknown>,
  ): GenerateResult['steps'][number] => ({
    ...step(undefined),
    index,
    ...(provider_reported !== undefined ? { provider_reported } : {}),
  })

  it('returns undefined when no step reported anything', () => {
    expect(last_provider_reported([])).toBeUndefined()
    expect(last_provider_reported([reported_step(0), reported_step(1)])).toBeUndefined()
  })

  it('takes the payload of the last reporting step', () => {
    const first = { bedrock: { trace: 'first' } }
    const last = { bedrock: { trace: 'last' } }
    expect(
      last_provider_reported([reported_step(0, first), reported_step(1, last)]),
    ).toBe(last)
  })

  it('skips back over later steps that reported nothing', () => {
    const first = { bedrock: { trace: 'first' } }
    expect(
      last_provider_reported([reported_step(0, first), reported_step(1), reported_step(2)]),
    ).toBe(first)
  })
})
