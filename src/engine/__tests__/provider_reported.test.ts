/**
 * provider_reported end to end over the ai_sdk transport.
 *
 * The AI SDK returns provider-volunteered detail on `providerMetadata` (bedrock's
 * guardrail trace, anthropic's cache breakdown, openai's own fields), already
 * keyed by provider name. These tests pin the three properties that make it
 * usable in-process, with the `ai` module mocked at the boundary so they cover
 * the transport rather than any one provider:
 *
 *   1. The keys and payloads ride through untranslated, so plumbing it once
 *      serves every ai_sdk provider.
 *   2. A streamed run and a plain run of the same turn report identically
 *      (`run`'s parity contract), since the SDK carries the metadata on the
 *      streamed finish-step as well as the generateText result.
 *   3. Multi-step calls keep every turn's payload on its step record, and the
 *      call-level field names the last turn that reported one.
 *   4. A schema call that ends on a non-`stop` finish throws rather than
 *      returning, so the payload has to ride the thrown
 *      `incomplete_generation_error` to stay reachable at all. This is the
 *      only route by which a caller can read a guardrail's own account of a
 *      block it just caused.
 *
 * The real-peer proof that a bedrock guardrail trace lands under the `bedrock`
 * key lives in providers/__tests__/bedrock_guardrail_wire.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { StreamChunk, Tool } from '../types.js'
import {
  build_mock_ai_module,
  build_mock_registry_module,
  enqueue_generate_text,
  enqueue_stream,
  make_text_result,
  reset_mock_state,
} from './fixtures/mock_ai.js'

vi.mock('ai', async () => build_mock_ai_module())
vi.mock('../providers/registry.js', async () => build_mock_registry_module())

import { create_engine } from '../create_engine.js'
import { incomplete_generation_error } from '../errors.js'

const CACHE_METADATA = { anthropic: { cacheCreationInputTokens: 320, cacheReadInputTokens: 0 } }

const USAGE = { inputTokens: 5, outputTokens: 3 }

function engine() {
  return create_engine({ providers: { anthropic: { api_key: 'k' } } })
}

function echo_tool(): Tool {
  return {
    name: 'echo',
    description: 'echo',
    input_schema: z.object({ value: z.string() }),
    execute: (input: unknown) => `echo:${(input as { value: string }).value}`,
  }
}

/** One tool-calling turn carrying the given provider metadata. */
function tool_turn(provider_metadata: Record<string, unknown>) {
  return {
    text: '',
    toolCalls: [{ toolCallId: 'c1', toolName: 'echo', input: { value: 'hi' } }],
    finishReason: 'tool-calls',
    usage: USAGE,
    providerMetadata: provider_metadata,
  }
}

beforeEach(() => reset_mock_state())
afterEach(() => reset_mock_state())

describe('provider_reported on a single-turn call', () => {
  it('surfaces the provider metadata on the result and the step record', async () => {
    enqueue_generate_text({ ...make_text_result('hello'), providerMetadata: CACHE_METADATA })

    const result = await engine().generate({ model: 'claude-opus-4-8', prompt: 'hi' })

    expect(result.provider_reported).toStrictEqual(CACHE_METADATA)
    expect(result.steps[0]?.provider_reported).toStrictEqual(CACHE_METADATA)
    expect(result.provider_reported?.['anthropic']).toStrictEqual({
      cacheCreationInputTokens: 320,
      cacheReadInputTokens: 0,
    })
  })

  it('keeps the SDK keys verbatim rather than re-keying them to the fascicle provider id', async () => {
    // The bedrock peer reports the same payload under both `amazonBedrock` and
    // `bedrock`. Driving it through the `anthropic` provider proves the
    // transport neither rewrites the keys nor nests them under the provider
    // name, so `provider_reported.bedrock.trace` needs no translation layer.
    const trace = { guardrail: { inputAssessment: { 'gr-1': { piiEntities: [] } } } }
    enqueue_generate_text({
      ...make_text_result('hello'),
      providerMetadata: { amazonBedrock: { trace }, bedrock: { trace } },
    })

    const result = await engine().generate({ model: 'claude-opus-4-8', prompt: 'hi' })

    expect(Object.keys(result.provider_reported ?? {})).toEqual(['amazonBedrock', 'bedrock'])
    expect(result.provider_reported?.['bedrock']).toStrictEqual({ trace })
  })

  it('omits the field entirely when the provider reports nothing', async () => {
    enqueue_generate_text(make_text_result('hello'))

    const result = await engine().generate({ model: 'claude-opus-4-8', prompt: 'hi' })

    expect('provider_reported' in result).toBe(false)
    expect('provider_reported' in (result.steps[0] ?? {})).toBe(false)
  })

  it('omits the field rather than reporting an empty object', async () => {
    enqueue_generate_text({ ...make_text_result('hello'), providerMetadata: {} })

    const result = await engine().generate({ model: 'claude-opus-4-8', prompt: 'hi' })

    expect('provider_reported' in result).toBe(false)
  })
})

describe('provider_reported stream/non-stream parity', () => {
  it('reports identically for a streamed and a plain run of the same turn', async () => {
    enqueue_generate_text({ ...make_text_result('hello'), providerMetadata: CACHE_METADATA })
    enqueue_stream([
      { type: 'text-delta', text: 'hello' },
      { type: 'finish-step', finishReason: 'stop', usage: USAGE, providerMetadata: CACHE_METADATA },
    ])

    const eng = engine()
    const plain = await eng.generate({ model: 'claude-opus-4-8', prompt: 'hi' })
    const streamed = await eng.generate({
      model: 'claude-opus-4-8',
      prompt: 'hi',
      on_chunk: () => {},
    })

    expect(streamed.provider_reported).toStrictEqual(plain.provider_reported)
    expect(streamed.provider_reported).toStrictEqual(CACHE_METADATA)
    expect(streamed.steps[0]?.provider_reported).toStrictEqual(CACHE_METADATA)
  })

  it('omits the field on a streamed run whose finish-step reports nothing', async () => {
    enqueue_stream([
      { type: 'text-delta', text: 'hello' },
      { type: 'finish-step', finishReason: 'stop', usage: USAGE },
    ])

    const result = await engine().generate({
      model: 'claude-opus-4-8',
      prompt: 'hi',
      on_chunk: () => {},
    })

    expect('provider_reported' in result).toBe(false)
  })

  it('carries the payload alongside a content_filter finish on both paths', async () => {
    enqueue_generate_text({
      ...make_text_result('blocked'),
      finishReason: 'content-filter',
      providerMetadata: CACHE_METADATA,
    })
    enqueue_stream([
      {
        type: 'finish-step',
        finishReason: 'content-filter',
        usage: USAGE,
        providerMetadata: CACHE_METADATA,
      },
    ])

    const eng = engine()
    const plain = await eng.generate({ model: 'claude-opus-4-8', prompt: 'hi' })
    const streamed = await eng.generate({
      model: 'claude-opus-4-8',
      prompt: 'hi',
      on_chunk: () => {},
    })

    expect(plain.finish_reason).toBe('content_filter')
    expect(streamed.finish_reason).toBe('content_filter')
    expect(plain.provider_reported).toStrictEqual(CACHE_METADATA)
    expect(streamed.provider_reported).toStrictEqual(CACHE_METADATA)
  })
})

describe('provider_reported across a multi-step tool call', () => {
  it('keeps each turn on its step record and takes the last reporting turn for the call', async () => {
    const first = { anthropic: { cacheCreationInputTokens: 320 } }
    const second = { anthropic: { cacheReadInputTokens: 320 } }
    enqueue_generate_text(tool_turn(first))
    enqueue_generate_text({ ...make_text_result('done'), providerMetadata: second })

    const result = await engine().generate({
      model: 'claude-opus-4-8',
      prompt: 'hi',
      tools: [echo_tool()],
    })

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]?.provider_reported).toStrictEqual(first)
    expect(result.steps[1]?.provider_reported).toStrictEqual(second)
    expect(result.provider_reported).toStrictEqual(second)
  })

  it('leaves the field off a tool-calling turn that reported nothing', async () => {
    const second = { anthropic: { cacheReadInputTokens: 320 } }
    enqueue_generate_text({ ...tool_turn({}), providerMetadata: {} })
    enqueue_generate_text({ ...make_text_result('done'), providerMetadata: second })

    const result = await engine().generate({
      model: 'claude-opus-4-8',
      prompt: 'hi',
      tools: [echo_tool()],
    })

    expect('provider_reported' in (result.steps[0] ?? {})).toBe(false)
    expect(result.steps[1]?.provider_reported).toStrictEqual(second)
    expect(result.provider_reported).toStrictEqual(second)
  })

  it('falls back to the last turn that reported when the final turn reports nothing', async () => {
    const first = { anthropic: { cacheCreationInputTokens: 320 } }
    enqueue_generate_text(tool_turn(first))
    enqueue_generate_text(make_text_result('done'))

    const result = await engine().generate({
      model: 'claude-opus-4-8',
      prompt: 'hi',
      tools: [echo_tool()],
    })

    expect(result.steps[0]?.provider_reported).toStrictEqual(first)
    expect('provider_reported' in (result.steps[1] ?? {})).toBe(false)
    expect(result.provider_reported).toStrictEqual(first)
  })
})

type GuardrailAssessment = {
  contentPolicy?: { filters?: Array<{ type: string; action: string }> }
  sensitiveInformationPolicy?: { piiEntities?: Array<{ type: string; action: string }> }
}

type GuardrailReport = {
  trace?: { guardrail?: { inputAssessment?: Record<string, GuardrailAssessment> } }
}

describe('provider_reported on a schema call that finishes without a validated value', () => {
  const schema = z.object({ verdict: z.string() })

  it('rides the thrown error on the plain path', async () => {
    enqueue_generate_text({
      ...make_text_result('blocked'),
      finishReason: 'content-filter',
      providerMetadata: CACHE_METADATA,
    })

    const err: unknown = await engine()
      .generate({ model: 'claude-opus-4-8', prompt: 'hi', schema })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(incomplete_generation_error)
    const incomplete = err as incomplete_generation_error
    expect(incomplete.finish_reason).toBe('content_filter')
    expect(incomplete.raw_text).toBe('blocked')
    expect(incomplete.provider_reported).toStrictEqual(CACHE_METADATA)
  })

  it('rides the thrown error on the streamed path, which emits no finish chunk', async () => {
    enqueue_stream([
      { type: 'text-delta', text: 'blocked' },
      {
        type: 'finish-step',
        finishReason: 'content-filter',
        usage: USAGE,
        providerMetadata: CACHE_METADATA,
      },
    ])

    const chunks: StreamChunk[] = []
    const err: unknown = await engine()
      .generate({
        model: 'claude-opus-4-8',
        prompt: 'hi',
        schema,
        on_chunk: (chunk) => {
          chunks.push(chunk)
        },
      })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(incomplete_generation_error)
    const incomplete = err as incomplete_generation_error
    expect(incomplete.finish_reason).toBe('content_filter')
    expect(incomplete.raw_text).toBe('blocked')
    expect(incomplete.provider_reported).toStrictEqual(CACHE_METADATA)
    expect(chunks.some((c) => c.kind === 'finish')).toBe(false)
  })

  it('exposes the guardrail assessment types on the error without reaching for the matched text', async () => {
    // The shape AWS returns under `trace: 'enabled'`. A safety consumer needs
    // the entity/action types to explain a block; `match` holds the offending
    // text itself and must stay out of any reasoning string it builds.
    const trace = {
      guardrail: {
        inputAssessment: {
          'gr-1': {
            contentPolicy: {
              filters: [{ type: 'PROMPT_ATTACK', confidence: 'HIGH', action: 'BLOCKED' }],
            },
            sensitiveInformationPolicy: {
              piiEntities: [{ type: 'EMAIL', match: 'a@b.example', action: 'ANONYMIZED' }],
            },
          },
        },
      },
    }
    enqueue_generate_text({
      ...make_text_result('Sorry, this request was blocked.'),
      finishReason: 'content-filter',
      providerMetadata: { bedrock: { trace } },
    })

    const err: unknown = await engine()
      .generate({ model: 'claude-opus-4-8', prompt: 'hi', schema })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(incomplete_generation_error)
    const reported = (err as incomplete_generation_error).provider_reported?.['bedrock'] as
      | GuardrailReport
      | undefined
    const assessment = reported?.trace?.guardrail?.inputAssessment?.['gr-1']
    const reasons = [
      ...(assessment?.contentPolicy?.filters ?? []).map((f) => `${f.type}:${f.action}`),
      ...(assessment?.sensitiveInformationPolicy?.piiEntities ?? []).map(
        (e) => `${e.type}:${e.action}`,
      ),
    ]
    expect(reasons).toEqual(['PROMPT_ATTACK:BLOCKED', 'EMAIL:ANONYMIZED'])
    expect(JSON.stringify(reasons)).not.toContain('a@b.example')
  })

  it('falls back to the last reporting turn when the blocked turn reports nothing', async () => {
    const first = { anthropic: { cacheCreationInputTokens: 320 } }
    enqueue_generate_text(tool_turn(first))
    enqueue_generate_text({ ...make_text_result('blocked'), finishReason: 'content-filter' })

    const err: unknown = await engine()
      .generate({ model: 'claude-opus-4-8', prompt: 'hi', schema, tools: [echo_tool()] })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(incomplete_generation_error)
    expect((err as incomplete_generation_error).provider_reported).toStrictEqual(first)
  })
})
