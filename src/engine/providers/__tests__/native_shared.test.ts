/**
 * native_shared.ts's assistant-part helpers: the filter that keeps a
 * reasoning part only for the provider whose key it carries, and the
 * three-way split the chat-completions and Ollama mappers serialize from.
 * The wire plumbing in the same module is covered through each adapter's own
 * tests, apart from `on_wire`, which every built-in native adapter reaches
 * through `invoke_http_turn` and which is tested here through a real engine.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TrajectoryLogger } from '#core'
import { create_engine } from '../../create_engine.js'
import type { AssistantContentPart, CapturePayload, EngineConfig } from '../../types.js'
import { is_own_reasoning, split_assistant_parts } from '../native_shared.js'

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
