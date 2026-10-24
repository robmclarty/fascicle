/**
 * Bedrock's ConverseStream wire, against the real `@ai-sdk/amazon-bedrock`
 * peer.
 *
 * The peer streams over `/converse-stream` in AWS's binary event-stream
 * encoding, which no other wire in this repo uses, so the suite first proves
 * its framer (`fixtures/converse_stream.ts`): a frame decodes to what it
 * encoded, and a flipped CRC fails. That check matters because the peer's
 * own decoder swallows a frame that fails to decode and ends the stream
 * there, so a framer bug would read as a stream cut off before its step
 * finished rather than as a bad frame.
 * It then drives one turn with tool calls through the peer against a fetch
 * stub that serves the framed stream, with a chunk consumer and without one,
 * and shows both folding to the text, tool calls, and usage that the same turn
 * gave as a JSON Converse response before every turn streamed.
 *
 * No test reaches the network: fetch is stubbed. The bearer-token auth path is
 * used, so no SigV4 signing or ambient AWS credentials are involved.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { create_bedrock_adapter } from '../bedrock.js'
import { create_ai_sdk_turn } from '../ai_sdk/invoke.js'
import { create_chunk_dispatcher } from '../../streaming.js'
import type { Message, StreamChunk, Tool, TurnResult } from '../../types.js'
import {
  converse_stream_response,
  decode_event_stream,
  encode_converse_stream,
  type ConverseStreamEvent,
} from './fixtures/converse_stream.js'

const MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0'

const MESSAGES: ReadonlyArray<Message> = [{ role: 'user', content: 'weather in Ottawa?' }]

const weather_tool: Tool = {
  name: 'get_weather',
  description: 'Look up current weather for a city',
  input_schema: z.object({ city: z.string() }),
  execute: () => 'sunny',
}

/**
 * A turn with text and a tool call as ConverseStream events, the text and the
 * tool input each split across two deltas.
 */
const TOOL_TURN_EVENTS: ReadonlyArray<ConverseStreamEvent> = [
  ['messageStart', { role: 'assistant' }],
  ['contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Checking ' } }],
  ['contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'the weather.' } }],
  ['contentBlockStop', { contentBlockIndex: 0 }],
  [
    'contentBlockStart',
    { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'tooluse_01', name: 'get_weather' } } },
  ],
  ['contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":' } } }],
  ['contentBlockDelta', { contentBlockIndex: 1, delta: { toolUse: { input: '"Ottawa"}' } } }],
  ['contentBlockStop', { contentBlockIndex: 1 }],
  ['messageStop', { stopReason: 'tool_use' }],
  ['metadata', { usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 }, metrics: { latencyMs: 410 } }],
]

/** Stub fetch with one response, returning the URLs it was called with. */
function stub_fetch(response: () => Response): string[] {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      urls.push(String(input))
      return response()
    }),
  )
  return urls
}

/** Drive one bedrock turn through the real peer, with a chunk consumer or without one. */
async function run_turn(on_chunk: ((chunk: StreamChunk) => void) | undefined): Promise<TurnResult> {
  const turn = create_ai_sdk_turn({
    adapter: create_bedrock_adapter({ region: 'us-east-1', api_key: 'test-bearer-token' }),
    model_id: MODEL_ID,
    dispatcher: create_chunk_dispatcher(on_chunk),
    tools: [weather_tool],
    schema: undefined,
    provider_options: undefined,
    temperature: undefined,
    max_tokens: undefined,
    top_p: undefined,
    reasoning: undefined,
    telemetry: undefined,
  })
  return turn({
    step_index: 0,
    messages: MESSAGES,
    abort: new AbortController().signal,
    observe_chunk: () => {},
  })
}

/** The fields a streamed turn and a whole one must agree on. */
function folded(result: TurnResult): unknown {
  return {
    text: result.text,
    tool_calls: result.tool_calls,
    finish_reason: result.finish_reason,
    usage: result.usage,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the ConverseStream framer', () => {
  it('decodes what it encodes, headers and payloads both', () => {
    expect(decode_event_stream(encode_converse_stream(TOOL_TURN_EVENTS))).toStrictEqual(
      TOOL_TURN_EVENTS.map(([event_type, payload]) => ({
        headers: { ':event-type': event_type, ':content-type': 'application/json', ':message-type': 'event' },
        payload,
      })),
    )
  })

  it('fails a frame whose prelude CRC or message CRC was flipped', () => {
    const prelude = encode_converse_stream(TOOL_TURN_EVENTS.slice(0, 1))
    prelude[9] = (prelude[9] ?? 0) ^ 0xff
    expect(() => decode_event_stream(prelude)).toThrow('frame at 0 has a bad prelude CRC')

    const message = encode_converse_stream(TOOL_TURN_EVENTS.slice(0, 2))
    const second = message.length - 1
    message[second] = (message[second] ?? 0) ^ 0xff
    expect(() => decode_event_stream(message)).toThrow(/^frame at \d+ has a bad message CRC$/)
  })

  it('shows why: the peer stops at a frame it cannot decode, which the transport reads as a cut-off stream', async () => {
    const bytes = encode_converse_stream(TOOL_TURN_EVENTS)
    const first_frame_end = new DataView(bytes.buffer).getUint32(0, false)
    bytes[first_frame_end - 1] = (bytes[first_frame_end - 1] ?? 0) ^ 0xff
    // The peer's decoder drops the bad frame and every frame after it without
    // an error, so its step finishes as 'other' with no raw reason, which the
    // transport throws in the network shape rather than return an empty turn.
    stub_fetch(() => new Response(bytes, { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream' } }))
    const caught = await run_turn(() => {}).catch((e: unknown) => e)
    expect(caught).toMatchObject({
      kind: 'network',
      message: 'bedrock stream ended before the step finished; the result would be truncated',
    })
  })
})

describe('bedrock ConverseStream through the real peer', () => {
  it('folds a framed stream, consumer or not, to what the JSON Converse response gave', async () => {
    const urls = stub_fetch(() => converse_stream_response(TOOL_TURN_EVENTS))
    const without = await run_turn(undefined)
    const chunks: StreamChunk[] = []
    const watched = await run_turn((chunk) => {
      chunks.push(chunk)
    })

    expect(urls).toStrictEqual([
      `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(MODEL_ID)}/converse-stream`,
      `https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent(MODEL_ID)}/converse-stream`,
    ])
    // The fold that the JSON Converse response for this turn gave through the
    // peer, before every turn streamed. The peer reports cache counts as zeros
    // when the wire carries none.
    expect(folded(without)).toStrictEqual({
      text: 'Checking the weather.',
      tool_calls: [{ id: 'tooluse_01', name: 'get_weather', input: { city: 'Ottawa' } }],
      finish_reason: 'tool_calls',
      usage: { input_tokens: 120, output_tokens: 40, cached_input_tokens: 0, cache_write_tokens: 0 },
    })
    expect(folded(watched)).toStrictEqual(folded(without))
    expect(chunks.map((c) => c.kind)).toStrictEqual([
      'text',
      'text',
      'tool_call_start',
      'tool_call_input_delta',
      'tool_call_input_delta',
      'tool_call_end',
      'step_finish',
    ])
  })
})
