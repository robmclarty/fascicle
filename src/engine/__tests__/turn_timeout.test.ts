/**
 * Turn-timeout budgets (Step 7 / D5).
 *
 * `turn_timeout_ms` composes a per-attempt deadline with the caller's abort
 * around every depth-1 turn, driven here through the real engine path
 * (create_engine -> generate -> build_native_invoke -> retry_turn) with an
 * in-memory fake native adapter. retry_turn is the wrapper BOTH depth-1
 * transports route through, so exercising the native fake exercises the same
 * timeout code the ai_sdk transport gets (generate.ts threads turn_timeout_ms
 * into build_ai_sdk_invoke and build_native_invoke identically).
 *
 * The ladder ordering is the subtle part: an expiry with no chunk streamed is a
 * retryable typed timeout, but an expiry AFTER chunks flowed is a non-retryable
 * stream interruption (C4 parity). Assertions are concrete: the thrown type,
 * the exact attempt count, and the timeout_ms carried on the error.
 */

import { describe, expect, it, vi } from 'vitest'
import { create_engine } from '../create_engine.js'
import {
  aborted_error,
  engine_config_error,
  on_chunk_error,
  provider_error,
  turn_timeout_error,
} from '../errors.js'
import type { ProviderFactory } from '../providers/types.js'
import type {
  EngineConfig,
  RetryPolicy,
  TurnRequest,
  TurnResult,
} from '../types.js'

const PROVIDER = 'fake_native'
const MODEL = 'nat-1'

/** No retry, no backoff: the raw thrown error surfaces immediately. */
const NO_RETRY: RetryPolicy = {
  max_attempts: 1,
  initial_delay_ms: 0,
  max_delay_ms: 0,
  retry_on: [],
}

/** Retries every classified transient (timeout + network) with zero backoff. */
const RETRY_TRANSIENTS: RetryPolicy = {
  max_attempts: 3,
  initial_delay_ms: 0,
  max_delay_ms: 0,
  retry_on: ['timeout', 'network'],
}

type Behavior =
  | { mode: 'fast'; text: string }
  | { mode: 'hang' }
  | { mode: 'throw'; error: Error }
  | { mode: 'stream_then_hang'; chunk_text: string }
  | { mode: 'stream_then_abort_error'; chunk_text: string }
  | { mode: 'stream_then_ok'; chunk_text: string; text: string }

type NativeLog = { requests: TurnRequest[] }

/**
 * Reject the way a real fetch does on abort: a plain Error named 'AbortError'
 * (NOT the engine's aborted_error), so retry_turn classifies via
 * timed_out()/has_streamed() exactly as it would for a genuine transport abort.
 */
function abort_like(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

function reject_on_abort(abort: AbortSignal, make_error: () => Error): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (abort.aborted) {
      reject(make_error())
      return
    }
    abort.addEventListener('abort', () => reject(make_error()), { once: true })
  })
}

function hang_until_abort(abort: AbortSignal): Promise<never> {
  return reject_on_abort(abort, abort_like)
}

/**
 * Reject with the engine's aborted_error on abort, mimicking the ai_sdk
 * transport: its collect_stream maps the SDK's mid-stream `abort` part to an
 * aborted_error regardless of whether the user or a deadline caused the abort.
 * retry_turn must classify by cause, not by this shape.
 */
function abort_error_until_aborted(abort: AbortSignal): Promise<never> {
  return reject_on_abort(abort, () => new aborted_error('aborted', { reason: abort.reason }))
}

function make_factory(log: NativeLog, behavior: Behavior): ProviderFactory {
  return () => ({
    kind: 'native',
    name: PROVIDER,
    invoke_turn: async (req: TurnRequest): Promise<TurnResult> => {
      log.requests.push(req)
      if (behavior.mode === 'fast') {
        return {
          text: behavior.text,
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      }
      if (behavior.mode === 'throw') {
        throw behavior.error
      }
      if (behavior.mode === 'stream_then_ok') {
        await req.dispatch_chunk?.({
          kind: 'text',
          text: behavior.chunk_text,
          step_index: req.step_index,
        })
        return {
          text: behavior.text,
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      }
      if (behavior.mode === 'stream_then_hang' || behavior.mode === 'stream_then_abort_error') {
        await req.dispatch_chunk?.({
          kind: 'text',
          text: behavior.chunk_text,
          step_index: req.step_index,
        })
        return behavior.mode === 'stream_then_abort_error'
          ? abort_error_until_aborted(req.abort)
          : hang_until_abort(req.abort)
      }
      return hang_until_abort(req.abort)
    },
    supports: () => true,
  })
}

function make_engine(
  log: NativeLog,
  behavior: Behavior,
  config?: Partial<EngineConfig>,
): ReturnType<typeof create_engine> {
  return create_engine({
    providers: { [PROVIDER]: {} },
    custom_providers: { [PROVIDER]: make_factory(log, behavior) },
    ...config,
  })
}

describe('turn_timeout_ms: expiry with no chunk streamed', () => {
  it('throws a typed turn_timeout_error carrying the budget', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, { mode: 'hang' })
    let err: unknown
    try {
      await engine.generate({
        provider: PROVIDER,
        model: MODEL,
        prompt: 'hi',
        turn_timeout_ms: 20,
        retry: NO_RETRY,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(turn_timeout_error)
    expect((err as turn_timeout_error).timeout_ms).toBe(20)
    expect((err as turn_timeout_error).kind).toBe('timeout')
    expect(log.requests).toHaveLength(1)
  })

  it('is retried by the shared classifier, then exhausts to provider_error', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, { mode: 'hang' })
    let err: unknown
    try {
      await engine.generate({
        provider: PROVIDER,
        model: MODEL,
        prompt: 'hi',
        turn_timeout_ms: 20,
        retry: RETRY_TRANSIENTS,
      })
    } catch (e) {
      err = e
    }
    // Each of the 3 attempts arms a fresh budget and times out; exhaustion
    // surfaces as a network-cause provider_error (retry.ts's timeout ladder).
    expect(err).toBeInstanceOf(provider_error)
    expect((err as provider_error).cause_kind).toBe('network')
    expect(log.requests).toHaveLength(3)
  })
})

describe('turn_timeout_ms: a fast turn does not fire', () => {
  it('resolves normally when the turn beats a generous budget', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, { mode: 'fast', text: 'done' })
    const result = await engine.generate({
      provider: PROVIDER,
      model: MODEL,
      prompt: 'hi',
      turn_timeout_ms: 10_000,
      retry: NO_RETRY,
    })
    expect(result.content).toBe('done')
    expect(log.requests).toHaveLength(1)
  })
})

describe('turn_timeout_ms: mid-stream expiry refuses retry (C4 parity)', () => {
  it('becomes a non-retryable stream interruption after a chunk has flowed', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, { mode: 'stream_then_hang', chunk_text: 'partial' })
    let err: unknown
    try {
      await engine.generate({
        provider: PROVIDER,
        model: MODEL,
        prompt: 'hi',
        on_chunk: () => {},
        turn_timeout_ms: 20,
        // Would retry a timeout OR network error — proving the refusal is the
        // stream-interruption rule, not an un-retryable policy.
        retry: RETRY_TRANSIENTS,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_error)
    expect((err as provider_error).message).toContain('stream interrupted')
    // cause_kind is the literal 'unknown' the interruption branch stamps; an
    // empty metadata object or empty string would leave it undefined/''.
    expect((err as provider_error).cause_kind).toBe('unknown')
    expect(err).not.toBeInstanceOf(turn_timeout_error)
    expect(log.requests).toHaveLength(1)
  })

  it('reclassifies an ai_sdk-style mid-stream abort as a stream interruption', async () => {
    // The ai_sdk transport throws aborted_error on a mid-stream abort; without
    // cause-first ordering a deadline expiry would surface as a user cancel
    // instead of a stream interruption, diverging from the native transport.
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, {
      mode: 'stream_then_abort_error',
      chunk_text: 'partial',
    })
    let err: unknown
    try {
      await engine.generate({
        provider: PROVIDER,
        model: MODEL,
        prompt: 'hi',
        on_chunk: () => {},
        turn_timeout_ms: 20,
        retry: RETRY_TRANSIENTS,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_error)
    expect((err as provider_error).message).toContain('stream interrupted')
    expect(err).not.toBeInstanceOf(aborted_error)
    expect(log.requests).toHaveLength(1)
  })

  it('still surfaces a genuine mid-stream user abort as aborted_error', async () => {
    // A real user abort must win over the stream-interruption branch: the same
    // aborted_error-throwing adapter, but the user cancels from on_chunk while
    // the deadline is generous.
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, {
      mode: 'stream_then_abort_error',
      chunk_text: 'partial',
    })
    const controller = new AbortController()
    let err: unknown
    try {
      await engine.generate({
        provider: PROVIDER,
        model: MODEL,
        prompt: 'hi',
        abort: controller.signal,
        on_chunk: () => {
          controller.abort(new Error('user cancel'))
        },
        turn_timeout_ms: 10_000,
        retry: RETRY_TRANSIENTS,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect(err).not.toBeInstanceOf(provider_error)
    // The re-thrown aborted_error carries the exact 'aborted' message and the
    // user's abort reason; an emptied message string or dropped metadata object
    // would blank these out.
    expect((err as aborted_error).message).toBe('aborted')
    expect((err as aborted_error).reason).toBeInstanceOf(Error)
    expect(((err as aborted_error).reason as Error).message).toBe('user cancel')
    expect(log.requests).toHaveLength(1)
  })
})

describe('turn_timeout_ms: resolution (per-call + engine default)', () => {
  it('applies the engine default when no per-call value is given', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, { mode: 'hang' }, {
      defaults: { turn_timeout_ms: 20 },
      default_retry: NO_RETRY,
    })
    let err: unknown
    try {
      await engine.generate({ provider: PROVIDER, model: MODEL, prompt: 'hi' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(turn_timeout_error)
    expect((err as turn_timeout_error).timeout_ms).toBe(20)
    expect(log.requests).toHaveLength(1)
  })

  it('lets a per-call value win over the engine default', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, { mode: 'hang' }, {
      defaults: { turn_timeout_ms: 10_000 },
      default_retry: NO_RETRY,
    })
    let err: unknown
    try {
      await engine.generate({
        provider: PROVIDER,
        model: MODEL,
        prompt: 'hi',
        turn_timeout_ms: 20,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(turn_timeout_error)
    // The 20ms per-call budget fired, not the 10s engine default.
    expect((err as turn_timeout_error).timeout_ms).toBe(20)
  })
})

describe('turn_timeout_ms: no budget leaves the abort ladder untimed', () => {
  it('passes the user signal through untouched (no deadline armed)', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, { mode: 'hang' })
    const controller = new AbortController()
    // The user aborts well after any 0ms deadline would fire. With no budget,
    // arm_turn_timeout returns the user signal untouched (timed_out() always
    // false), so the hang ends only on this abort -> aborted_error. The mutant
    // that always arms would fire a coerced-0ms deadline first and surface a
    // turn_timeout_error instead.
    const timer = setTimeout(() => controller.abort(new Error('user cancel')), 25)
    let err: unknown
    try {
      await engine.generate({
        provider: PROVIDER,
        model: MODEL,
        prompt: 'hi',
        abort: controller.signal,
        retry: NO_RETRY,
      })
    } catch (e) {
      err = e
    } finally {
      clearTimeout(timer)
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect(err).not.toBeInstanceOf(turn_timeout_error)
  })
})

describe('turn_timeout_ms: a generous budget never diverts a real failure', () => {
  it('surfaces a pre-chunk failure unclassified rather than as a timeout', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, { mode: 'throw', error: new Error('boom') })
    let err: unknown
    try {
      await engine.generate({
        provider: PROVIDER,
        model: MODEL,
        prompt: 'hi',
        turn_timeout_ms: 10_000,
        retry: NO_RETRY,
      })
    } catch (e) {
      err = e
    }
    // The 10s budget never fires, so the raw error passes through. The mutant
    // that initializes timed_out=true would divert it into the turn_timeout
    // branch even though the deadline never expired.
    expect(err).not.toBeInstanceOf(turn_timeout_error)
    expect((err as Error).message).toBe('boom')
    expect(log.requests).toHaveLength(1)
  })

  it('clears the armed deadline after a fast success (no leaked timer)', async () => {
    vi.useFakeTimers()
    try {
      const log: NativeLog = { requests: [] }
      const engine = make_engine(log, { mode: 'fast', text: 'done' })
      const result = await engine.generate({
        provider: PROVIDER,
        model: MODEL,
        prompt: 'hi',
        turn_timeout_ms: 10_000,
        retry: NO_RETRY,
      })
      expect(result.content).toBe('done')
      // dispose() (via retry_turn's finally) cleared the setTimeout. The empty
      // dispose body and the finally-skips-dispose mutants both leave it armed.
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('native transport: a throwing stream consumer cancels in-flight', () => {
  it('surfaces on_chunk_error when on_chunk throws mid-stream', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, {
      mode: 'stream_then_ok',
      chunk_text: 'partial',
      text: 'unreached',
    })
    let err: unknown
    try {
      await engine.generate({
        provider: PROVIDER,
        model: MODEL,
        prompt: 'hi',
        on_chunk: () => {
          throw new Error('consumer boom')
        },
        retry: NO_RETRY,
      })
    } catch (e) {
      err = e
    }
    // dispatch_chunk's catch aborts the internal controller and rethrows the
    // on_chunk_error; if that catch block were emptied the error would be
    // swallowed and the turn would resolve with 'unreached'.
    expect(err).toBeInstanceOf(on_chunk_error)
    expect(log.requests).toHaveLength(1)
  })
})

describe('turn_timeout_ms: validation', () => {
  it('rejects a non-positive per-call budget before invoking the adapter', async () => {
    const log: NativeLog = { requests: [] }
    const engine = make_engine(log, { mode: 'fast', text: 'x' })
    const base = { provider: PROVIDER, model: MODEL, prompt: 'hi' } as const
    await expect(
      engine.generate({ ...base, turn_timeout_ms: 0 }),
    ).rejects.toBeInstanceOf(engine_config_error)
    await expect(
      engine.generate({ ...base, turn_timeout_ms: -5 }),
    ).rejects.toBeInstanceOf(engine_config_error)
    expect(log.requests).toHaveLength(0)
  })

  it('rejects a non-positive engine-default budget at construction', () => {
    const log: NativeLog = { requests: [] }
    expect(() =>
      make_engine(log, { mode: 'fast', text: 'x' }, {
        defaults: { turn_timeout_ms: 0 },
      }),
    ).toThrow(engine_config_error)
  })
})
