/**
 * Bedrock guardrail wire contract.
 *
 * `provider_options.bedrock.guardrailConfig` reaches the top level of the
 * Converse command through a seam @ai-sdk/amazon-bedrock does not document:
 * its provider-options schema lists only additionalModelRequestFields,
 * reasoningConfig, anthropicBeta, and serviceTier, but its request builder
 * rest-spreads the remaining raw option keys into the command body. A peer
 * upgrade that tightens that spread to schema-validated keys would drop
 * guardrails silently (a compliance feature failing open), so this suite pins
 * the behavior at the wire: stub fetch, drive the real peer through
 * create_ai_sdk_turn, and assert on the captured request body.
 *
 * The return leg is pinned here too. With `trace: 'enabled'` the peer reports
 * the assessment on `providerMetadata`, which the transport passes through to
 * `provider_reported`, so the suite asserts the trace lands under the `bedrock`
 * key against the real peer's own shape rather than a hand-built payload.
 *
 * No live network (C5): fetch is stubbed. The bearer-token auth path is used,
 * so no SigV4 signing or ambient AWS credentials are involved, and the peer
 * loads lazily inside build_model, after the stub is installed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { create_bedrock_adapter, translate_bedrock_effort } from '../bedrock.js'
import { create_ai_sdk_turn } from '../ai_sdk/invoke.js'
import { create_chunk_dispatcher } from '../../streaming.js'
import { merge_provider_options } from '../../merge_defaults.js'
import type { Message, TurnResult } from '../../types.js'

const MODEL_ID = 'us.anthropic.claude-sonnet-4-20250514-v1:0'

const MESSAGES: ReadonlyArray<Message> = [{ role: 'user', content: 'say hi' }]

const GUARDRAIL_CONFIG = {
  guardrailIdentifier: 'arn:aws:bedrock:us-east-1:000000000000:guardrail/test',
  guardrailVersion: '1',
  trace: 'enabled',
}

const json_record = z.record(z.string(), z.unknown())

const provider_options_record = z.record(z.string(), z.record(z.string(), z.unknown()))

type CapturedRequest = {
  readonly url: string
  readonly body: Record<string, unknown>
}

/**
 * A guardrail trace as AWS shapes it with `trace: 'enabled'`: an assessment
 * with a PII entity whose action is NONE, meaning detected and reported but
 * not rewritten. The model output is byte-identical with or without the
 * guardrail attached, so this payload is the only in-process evidence the
 * guardrail ran at all.
 */
const GUARDRAIL_TRACE = {
  guardrail: {
    inputAssessment: {
      'gr-1': {
        sensitiveInformationPolicy: {
          piiEntities: [{ type: 'EMAIL', match: 'a@b.example', action: 'NONE' }],
        },
      },
    },
  },
}

/** Minimal Converse response the SDK's response schema accepts. */
function converse_response(stop_reason: string, trace?: unknown): Response {
  return new Response(
    JSON.stringify({
      output: { message: { role: 'assistant', content: [{ text: 'hello' }] } },
      stopReason: stop_reason,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      ...(trace !== undefined ? { trace } : {}),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/**
 * Stub global fetch to capture each outgoing request and answer with a fixed
 * Converse response. Returns the capture list, which fills as calls land.
 */
function stub_capturing_fetch(stop_reason: string, trace?: unknown): CapturedRequest[] {
  const captured: CapturedRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      const parsed: unknown = JSON.parse(raw)
      captured.push({ url: String(input), body: json_record.parse(parsed) })
      return converse_response(stop_reason, trace)
    }),
  )
  return captured
}

/**
 * Drive one non-streamed bedrock turn through the real @ai-sdk/amazon-bedrock
 * peer with the given already-merged provider options.
 */
async function run_turn(
  provider_options: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
): Promise<TurnResult> {
  const adapter = create_bedrock_adapter({ region: 'us-east-1', api_key: 'test-bearer-token' })
  const turn = create_ai_sdk_turn({
    adapter,
    model_id: MODEL_ID,
    dispatcher: create_chunk_dispatcher(undefined),
    tools: [],
    schema: undefined,
    provider_options,
    temperature: undefined,
    max_tokens: undefined,
    top_p: undefined,
    telemetry: undefined,
  })
  return turn({
    step_index: 0,
    messages: MESSAGES,
    abort: new AbortController().signal,
    stream: false,
    on_first_chunk: () => {},
  })
}

/** Read the single captured request, failing the test if none landed. */
function single_request(captured: ReadonlyArray<CapturedRequest>): CapturedRequest {
  const request = captured[0]
  if (request === undefined || captured.length !== 1) {
    throw new Error(`expected exactly one captured request, got ${captured.length}`)
  }
  return request
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('bedrock guardrail wire contract', () => {
  it('spreads provider_options.bedrock.guardrailConfig into the top level of the Converse command', async () => {
    const captured = stub_capturing_fetch('end_turn')
    await run_turn({ bedrock: { guardrailConfig: GUARDRAIL_CONFIG } })

    const request = single_request(captured)
    expect(request.url).toContain('/converse')
    expect(request.body['guardrailConfig']).toEqual(GUARDRAIL_CONFIG)
  })

  it('keeps guardrailConfig intact when merged with the effort translation', async () => {
    const captured = stub_capturing_fetch('end_turn')
    const merged = merge_provider_options(translate_bedrock_effort('low').provider_options, {
      bedrock: { guardrailConfig: GUARDRAIL_CONFIG },
    })
    await run_turn(provider_options_record.parse(merged))

    // The SDK consumes reasoningConfig and re-emits it as the Anthropic
    // thinking block; both halves of the merge must reach the wire.
    const request = single_request(captured)
    expect(request.body['guardrailConfig']).toEqual(GUARDRAIL_CONFIG)
    const additional = json_record.parse(request.body['additionalModelRequestFields'])
    expect(additional['thinking']).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(request.body['reasoningConfig']).toBeUndefined()
  })

  it('surfaces a guardrail intervention as finish_reason content_filter', async () => {
    stub_capturing_fetch('guardrail_intervened')
    const result = await run_turn({ bedrock: { guardrailConfig: GUARDRAIL_CONFIG } })
    expect(result.finish_reason).toBe('content_filter')
  })

  it('round-trips the guardrail trace to provider_reported.bedrock.trace', async () => {
    stub_capturing_fetch('guardrail_intervened', GUARDRAIL_TRACE)
    const result = await run_turn({ bedrock: { guardrailConfig: GUARDRAIL_CONFIG } })

    // The peer keys the payload under both `bedrock` and its own
    // `amazonBedrock` alias; `bedrock` is the one that matches fascicle's
    // provider id, so it is what a caller narrows on.
    expect(result.provider_reported?.['bedrock']).toMatchObject({ trace: GUARDRAIL_TRACE })
    expect(result.provider_reported?.['amazonBedrock']).toMatchObject({ trace: GUARDRAIL_TRACE })

    // The trace is additive: the intervention still maps to content_filter.
    expect(result.finish_reason).toBe('content_filter')
  })

  it('reports no trace key when the guardrail runs without trace enabled', async () => {
    stub_capturing_fetch('end_turn')
    const result = await run_turn({
      bedrock: { guardrailConfig: { ...GUARDRAIL_CONFIG, trace: 'disabled' } },
    })
    const reported = result.provider_reported?.['bedrock']
    expect(reported === undefined || !('trace' in json_record.parse(reported))).toBe(true)
  })
})
