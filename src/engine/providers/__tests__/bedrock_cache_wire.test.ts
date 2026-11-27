/**
 * Bedrock prompt-cache wire contract.
 *
 * A cache setting of `'5m'` or `'1h'` has to reach the Converse command as a
 * `cache_control` inside `additionalModelRequestFields`, which is the model
 * field that turns on Bedrock's automatic prompt caching for the Claude
 * models that take it. Two
 * things sit between the setting and the wire: the engine, which lays the
 * adapter's translation over the caller's provider options, and
 * @ai-sdk/amazon-bedrock, which reads its options under `amazonBedrock` when
 * that key is present and under `bedrock` only otherwise. So this suite
 * drives `generate` on a real engine through the real peer, stubs fetch, and
 * asserts on the request bodies that were captured.
 *
 * Every turn streams, so the stub answers with the framed event stream from
 * `fixtures/converse_stream.ts`. The bearer-token auth path is used, so no
 * SigV4 signing or ambient AWS credentials are involved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { TrajectoryEvent } from '#core'
import { create_engine } from '../../create_engine.js'
import type { GenerateOptions, Tool } from '../../types.js'
import { converse_stream_response, type ConverseStreamEvent } from './fixtures/converse_stream.js'

const MODEL_ID = 'us.anthropic.claude-sonnet-5-5'

const GUARDRAIL_CONFIG = {
  guardrailIdentifier: 'arn:aws:bedrock:us-east-1:000000000000:guardrail/test',
  guardrailVersion: '1',
}

const json_record = z.record(z.string(), z.unknown())

const weather_tool: Tool = {
  name: 'get_weather',
  description: 'Look up current weather for a city',
  input_schema: z.object({ city: z.string() }),
  execute: () => 'sunny',
}

const USAGE: ConverseStreamEvent = [
  'metadata',
  { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 1 } },
]

const TOOL_TURN: ReadonlyArray<ConverseStreamEvent> = [
  ['messageStart', { role: 'assistant' }],
  [
    'contentBlockStart',
    { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'tooluse_01', name: 'get_weather' } } },
  ],
  ['contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: '{"city":"Ottawa"}' } } }],
  ['contentBlockStop', { contentBlockIndex: 0 }],
  ['messageStop', { stopReason: 'tool_use' }],
  USAGE,
]

const TEXT_TURN: ReadonlyArray<ConverseStreamEvent> = [
  ['messageStart', { role: 'assistant' }],
  ['contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'sunny' } }],
  ['contentBlockStop', { contentBlockIndex: 0 }],
  ['messageStop', { stopReason: 'end_turn' }],
  USAGE,
]

type Sent = {
  readonly bodies: ReadonlyArray<Record<string, unknown>>
  readonly events: ReadonlyArray<TrajectoryEvent>
}

/**
 * Run one `generate` call on a bedrock engine through the real peer, answering
 * the first request with a tool call when the call has tools and every other
 * request with text. Returns each request body and the trajectory's events.
 */
async function send(call: Partial<GenerateOptions>): Promise<Sent> {
  const bodies: Record<string, unknown>[] = []
  const has_tools = call.tools !== undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      const parsed: unknown = JSON.parse(raw)
      bodies.push(json_record.parse(parsed))
      return converse_stream_response(has_tools && bodies.length === 1 ? TOOL_TURN : TEXT_TURN)
    }),
  )
  const events: TrajectoryEvent[] = []
  const engine = create_engine({
    providers: { bedrock: { region: 'us-east-1', api_key: 'test-bearer-token' } },
  })
  await engine.generate({
    model: MODEL_ID,
    provider: 'bedrock',
    prompt: 'what is the weather in Ottawa?',
    trajectory: { record: (e) => events.push(e), start_span: () => 'span', end_span: () => {} },
    ...call,
  })
  return { bodies, events }
}

/** The `additionalModelRequestFields` of one request body, or undefined. */
function model_fields(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const fields = body['additionalModelRequestFields']
  return fields === undefined ? undefined : json_record.parse(fields)
}

/** The `option_ignored` events a call recorded for `cache`. */
function ignored_cache(events: ReadonlyArray<TrajectoryEvent>): ReadonlyArray<TrajectoryEvent> {
  return events.filter((e) => e.kind === 'option_ignored' && e['option'] === 'cache')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bedrock prompt-cache wire contract', () => {
  it("sends cache_control on every turn of a tool loop, beside the caller's own fields and a guardrail", async () => {
    const { bodies, events } = await send({
      tools: [weather_tool],
      cache: '5m',
      provider_options: {
        bedrock: {
          guardrailConfig: GUARDRAIL_CONFIG,
          additionalModelRequestFields: { output_config: { effort: 'low' } },
        },
      },
    })

    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(model_fields(body)).toStrictEqual({
        output_config: { effort: 'low' },
        cache_control: { type: 'ephemeral' },
      })
      expect(body['guardrailConfig']).toStrictEqual(GUARDRAIL_CONFIG)
      expect(body).not.toHaveProperty('cache_control')
    }
    expect(ignored_cache(events)).toStrictEqual([])
  })

  it("sends the one-hour ttl for cache: '1h'", async () => {
    const { bodies, events } = await send({ cache: '1h' })

    expect(bodies).toHaveLength(1)
    expect(model_fields(bodies[0] ?? {})).toStrictEqual({ cache_control: { type: 'ephemeral', ttl: '1h' } })
    expect(ignored_cache(events)).toStrictEqual([])
  })

  it("sends no cache_control for cache: 'off', or for a call that sets none, tools or not", async () => {
    const calls: ReadonlyArray<Partial<GenerateOptions>> = [{ cache: 'off' }, {}, { tools: [weather_tool] }]
    for (const call of calls) {
      const { bodies, events } = await send(call)
      expect(bodies).toHaveLength(call.tools === undefined ? 1 : 2)
      for (const body of bodies) {
        expect(body['messages']).toBeDefined()
        expect(JSON.stringify(body)).not.toContain('cache_control')
      }
      expect(ignored_cache(events)).toStrictEqual([])
    }
  })

  it('keeps cache_control beside the fields that the peer writes for effort', async () => {
    const { bodies } = await send({ cache: '5m', effort: 'high' })

    expect(bodies).toHaveLength(1)
    expect(model_fields(bodies[0] ?? {})).toStrictEqual({
      cache_control: { type: 'ephemeral' },
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    })
  })

  it('takes the engine default as the setting when the call sets none', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
        const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
        bodies.push(json_record.parse(parsed))
        return converse_stream_response(TEXT_TURN)
      }),
    )
    const engine = create_engine({
      providers: { bedrock: { region: 'us-east-1', api_key: 'test-bearer-token' } },
      defaults: { cache: '5m' },
    })
    await engine.generate({ model: MODEL_ID, provider: 'bedrock', prompt: 'hi' })

    expect(bodies).toHaveLength(1)
    expect(model_fields(bodies[0] ?? {})).toStrictEqual({ cache_control: { type: 'ephemeral' } })
  })

  it("leaves a caller's own cache_control as it is", async () => {
    const { bodies } = await send({
      cache: '5m',
      provider_options: {
        bedrock: { additionalModelRequestFields: { cache_control: { type: 'ephemeral', ttl: '1h' } } },
      },
    })

    expect(model_fields(bodies[0] ?? {})).toStrictEqual({ cache_control: { type: 'ephemeral', ttl: '1h' } })
  })

  it('writes under amazonBedrock when the caller passes options there, since the peer reads no bedrock key beside it', async () => {
    const { bodies } = await send({
      cache: '5m',
      provider_options: {
        amazonBedrock: {
          guardrailConfig: GUARDRAIL_CONFIG,
          additionalModelRequestFields: { output_config: { effort: 'low' } },
        },
      },
    })

    expect(bodies).toHaveLength(1)
    expect(model_fields(bodies[0] ?? {})).toStrictEqual({
      output_config: { effort: 'low' },
      cache_control: { type: 'ephemeral' },
    })
    expect(bodies[0]?.['guardrailConfig']).toStrictEqual(GUARDRAIL_CONFIG)
  })

  it('pins the seam: the peer drops a bedrock key that sits beside an amazonBedrock one', async () => {
    const { bodies } = await send({
      provider_options: {
        amazonBedrock: { guardrailConfig: GUARDRAIL_CONFIG },
        bedrock: { additionalModelRequestFields: { cache_control: { type: 'ephemeral' } } },
      },
    })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.['guardrailConfig']).toStrictEqual(GUARDRAIL_CONFIG)
    expect(JSON.stringify(bodies[0])).not.toContain('cache_control')
  })

  it('reads the one-hour part of a cache write back from the cacheDetails that Converse reports', async () => {
    const usage_event: ConverseStreamEvent = [
      'metadata',
      {
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 115,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 100,
          cacheDetails: [
            { ttl: '1h', inputTokens: 80 },
            { ttl: '5m', inputTokens: 20 },
          ],
        },
        metrics: { latencyMs: 1 },
      },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => converse_stream_response([...TEXT_TURN.slice(0, -1), usage_event])),
    )
    const engine = create_engine({
      providers: { bedrock: { region: 'us-east-1', api_key: 'test-bearer-token' } },
    })
    const result = await engine.generate({
      model: MODEL_ID,
      provider: 'bedrock',
      prompt: 'what is the weather in Ottawa?',
      cache: '1h',
    })

    expect(result.usage).toMatchObject({
      input_tokens: 110,
      cache_write_tokens: 100,
      cache_write_1h_tokens: 80,
    })
  })
})
