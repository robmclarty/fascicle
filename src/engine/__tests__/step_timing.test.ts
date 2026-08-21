/**
 * StepTiming: the engine's wall-clock measurement of each provider
 * round-trip, the primitive behind tokens-per-second.
 *
 * Driven through the real path (create_engine -> generate ->
 * build_native_invoke -> retry_turn -> run_tool_loop) with an in-memory fake
 * native adapter, faking only Date so durations are exact: the adapter moves
 * the clock forward at scripted points and the assertions pin exact
 * started_at / duration_ms / first_chunk_ms values. retry_turn is the wrapper
 * both transports route through (see turn_timeout.test.ts for the argument),
 * so the native fake exercises the same stamping the ai_sdk transport gets.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import { create_engine } from '../create_engine.js'
import type { ProviderFactory } from '../providers/types.js'
import type {
  RetryPolicy,
  Tool,
  TurnRequest,
  TurnResult,
} from '../types.js'
import { throughput } from '../throughput.js'

const PROVIDER = 'fake_native'
const MODEL = 'nat-1'
const T0 = 1_700_000_000_000

const NO_RETRY: RetryPolicy = {
  max_attempts: 1,
  initial_delay_ms: 0,
  max_delay_ms: 0,
  retry_on: [],
}

/** Zero-backoff network retry, so the clock only moves where scripted. */
const RETRY_NETWORK: RetryPolicy = {
  max_attempts: 3,
  initial_delay_ms: 0,
  max_delay_ms: 0,
  retry_on: ['network'],
}

/** Move the faked Date forward without touching real timers. */
function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms)
}

function make_engine(
  invoke: (req: TurnRequest) => Promise<TurnResult>,
): ReturnType<typeof create_engine> {
  const factory: ProviderFactory = () => ({
    kind: 'native',
    name: PROVIDER,
    invoke_turn: invoke,
    supports: () => true,
  })
  return create_engine({
    providers: { [PROVIDER]: {} },
    custom_providers: { [PROVIDER]: factory },
  })
}

function text_turn(text: string, output_tokens = 2): TurnResult {
  return {
    text,
    tool_calls: [],
    finish_reason: 'stop',
    usage: { input_tokens: 4, output_tokens },
  }
}

function make_recorder(): { trajectory: TrajectoryLogger; records: TrajectoryEvent[] } {
  const records: TrajectoryEvent[] = []
  return {
    trajectory: {
      record: (event) => {
        records.push(event)
      },
      start_span: () => 'span',
      end_span: () => {},
    },
    records,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('StepTiming on the engine loop', () => {
  it('stamps started_at and duration_ms around a non-streamed turn', async () => {
    const { trajectory, records } = make_recorder()
    const engine = make_engine(async () => {
      advance(250)
      return text_turn('done')
    })
    const result = await engine.generate({
      provider: PROVIDER,
      model: MODEL,
      prompt: 'hi',
      retry: NO_RETRY,
      trajectory,
    })
    // Exact equality also pins first_chunk_ms ABSENT on a non-streamed turn.
    expect(result.steps[0]?.timing).toEqual({ started_at: T0, duration_ms: 250 })
    const received = records.find((e) => e.kind === 'response_received')
    expect(received?.['duration_ms']).toBe(250)
  })

  it('stamps first_chunk_ms from the first chunk, not a later one', async () => {
    const engine = make_engine(async (req) => {
      advance(100)
      await req.dispatch_chunk?.({ kind: 'text', text: 'a', step_index: req.step_index })
      advance(100)
      await req.dispatch_chunk?.({ kind: 'text', text: 'b', step_index: req.step_index })
      advance(50)
      return text_turn('ab')
    })
    const result = await engine.generate({
      provider: PROVIDER,
      model: MODEL,
      prompt: 'hi',
      retry: NO_RETRY,
      on_chunk: () => {},
    })
    expect(result.steps[0]?.timing).toEqual({
      started_at: T0,
      duration_ms: 250,
      first_chunk_ms: 100,
    })
  })

  it('times the successful attempt only: failed attempts and backoff excluded', async () => {
    let attempts = 0
    const engine = make_engine(async () => {
      attempts += 1
      if (attempts === 1) {
        advance(40)
        throw Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })
      }
      advance(250)
      return text_turn('recovered')
    })
    const result = await engine.generate({
      provider: PROVIDER,
      model: MODEL,
      prompt: 'hi',
      retry: RETRY_NETWORK,
    })
    expect(attempts).toBe(2)
    expect(result.steps[0]?.timing).toEqual({ started_at: T0 + 40, duration_ms: 250 })
  })

  it('times each step round-trip separately, excluding tool execution', async () => {
    const tool: Tool = {
      name: 'slow',
      description: 'a slow tool',
      input_schema: z.object({ value: z.string() }),
      execute: () => {
        advance(500)
        return 'ok'
      },
    }
    let calls = 0
    const engine = make_engine(async () => {
      calls += 1
      if (calls === 1) {
        advance(200)
        return {
          text: '',
          tool_calls: [{ id: 'c1', name: 'slow', input: { value: 'x' } }],
          finish_reason: 'tool_calls',
          usage: { input_tokens: 4, output_tokens: 2 },
        }
      }
      advance(300)
      return text_turn('final')
    })
    const result = await engine.generate({
      provider: PROVIDER,
      model: MODEL,
      prompt: 'hi',
      retry: NO_RETRY,
      tools: [tool],
    })
    expect(result.steps[0]?.timing).toEqual({ started_at: T0, duration_ms: 200 })
    // The 500ms tool execution sits between the turns but inside neither.
    expect(result.steps[1]?.timing).toEqual({ started_at: T0 + 700, duration_ms: 300 })
    // The derived call-level rate divides by model time only: 4 output
    // tokens over 500ms of round-trip, not over the 1000ms wall clock.
    expect(throughput(result)).toEqual({
      tokens_per_second: 8,
      basis: 'blended',
      output_tokens: 4,
      measured_ms: 500,
    })
  })
})
