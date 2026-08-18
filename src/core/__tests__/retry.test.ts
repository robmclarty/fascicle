import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { aborted_error, suspended_error } from '../errors.js'
import { retry } from '../retry.js'
import { run } from '../runner.js'
import { step } from '../step.js'
import { suspend } from '../suspend.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'

const noop_on_error = (): void => {}

describe('retry', () => {
  it('throws twice then succeeds with max_attempts 3 (spec §10 test 5)', async () => {
    let calls = 0
    const errors: number[] = []
    const inner = step('flaky', (_: number) => {
      calls += 1
      if (calls < 3) throw new Error(`attempt ${calls} failed`)
      return 'ok'
    })
  
    const flow = retry(inner, {
      max_attempts: 3,
      backoff_ms: 1,
      on_error: (_err, attempt) => {
        errors.push(attempt)
      },
    })
  
    const result = await run(flow, 0, { install_signal_handlers: false })
    expect(result).toBe('ok')
    expect(calls).toBe(3)
    expect(errors).toEqual([1, 2])
  })

  it('observes exponential backoff between attempts', async () => {
    let calls = 0
    const marks: number[] = []
    const inner = step('flaky', (_: number) => {
      marks.push(Date.now())
      calls += 1
      if (calls < 3) throw new Error('fail')
      return 'ok'
    })
  
    const flow = retry(inner, { max_attempts: 3, backoff_ms: 20 })
  
    await run(flow, 0, { install_signal_handlers: false })
  
    expect(marks.length).toBe(3)
    const first_gap = (marks[1] ?? 0) - (marks[0] ?? 0)
    const second_gap = (marks[2] ?? 0) - (marks[1] ?? 0)
    expect(first_gap).toBeGreaterThanOrEqual(18)
    expect(second_gap).toBeGreaterThanOrEqual(38)
  })

  it('rethrows the last error if all attempts fail', async () => {
    let calls = 0
    const inner = step('always_fail', (_: number) => {
      calls += 1
      throw new Error(`attempt ${calls}`)
    })
  
    const flow = retry(inner, { max_attempts: 2, backoff_ms: 1 })
  
    await expect(run(flow, 0, { install_signal_handlers: false })).rejects.toThrow('attempt 2')
    expect(calls).toBe(2)
  })

  it('wraps inner execution in a retry span', async () => {
    const { logger, events } = recording_logger()
    const flow = retry(step('ok', (x: number) => x), { max_attempts: 1 })
  
    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })
  
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'retry')
    expect(start).toBeDefined()
    const end = events.find((e) => e.kind === 'span_end' && e['span_id'] === start?.['span_id'])
    expect(end).toBeDefined()
    expect(end?.['error']).toBeUndefined()
  })

  it('records error on span_end when all attempts fail', async () => {
    const { logger, events } = recording_logger()
    const flow = retry(
      step('bad', () => {
        throw new Error('boom')
      }),
      { max_attempts: 1 },
    )
  
    await expect(
      run(flow, 0, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toThrow('boom')
  
    const retry_end = events.find(
      (e) => e.kind === 'span_end' && typeof e['error'] === 'string' && e['error'] === 'boom',
    )
    expect(retry_end).toBeDefined()
  })

  it('accumulates cleanup handlers across attempts, LIFO (criterion 28, F11)', async () => {
    const fired: number[] = []
    let attempt = 0
    const inner = step('attempt', (_: number, ctx) => {
      attempt += 1
      const n = attempt
      ctx.on_cleanup(() => {
        fired.push(n)
      })
      if (attempt < 3) throw new Error(`fail ${attempt}`)
      return 'ok'
    })
  
    const flow = retry(inner, { max_attempts: 3, backoff_ms: 1 })
  
    const result = await run(flow, 0, { install_signal_handlers: false })
    expect(result).toBe('ok')
    expect(fired).toEqual([3, 2, 1])
  })

  it('does not retry past a suspend: fires on() once and never calls on_error', async () => {
    const on_spy = vi.fn(async () => {})
    const on_error = vi.fn()
    const inner = suspend({
      id: 'gate',
      on: on_spy,
      resume_schema: z.object({ ok: z.boolean() }),
      combine: (_: number, r) => (r.ok ? 1 : 0),
    })
    const flow = retry(inner, { max_attempts: 3, backoff_ms: 1, on_error })

    await expect(
      run(flow, 0, { install_signal_handlers: false }),
    ).rejects.toBeInstanceOf(suspended_error)
    expect(on_spy).toHaveBeenCalledTimes(1)
    expect(on_error).not.toHaveBeenCalled()
  })

  it('resumes a suspended inner through retry', async () => {
    const inner = suspend({
      id: 'gate',
      on: async () => {},
      resume_schema: z.object({ ok: z.boolean() }),
      combine: (_: number, r) => (r.ok ? 'go' : 'stop'),
    })
    const flow = retry(inner, { max_attempts: 3, backoff_ms: 1 })

    const result = await run(flow, 0, {
      install_signal_handlers: false,
      resume_data: { gate: { ok: true } },
    })

    expect(result).toBe('go')
  })

  it('rejects a NaN max_attempts at construction', () => {
    const inner = step('x', (n: number) => n)
    expect(() => retry(inner, { max_attempts: Number.NaN })).toThrow(TypeError)
    expect(() => retry(inner, { max_attempts: Number.NaN })).toThrow(
      'retry: max_attempts must be a finite number, got NaN',
    )
  })

  it('rejects an Infinity max_attempts at construction', () => {
    const inner = step('x', (n: number) => n)
    expect(() => retry(inner, { max_attempts: Number.POSITIVE_INFINITY })).toThrow(TypeError)
    expect(() => retry(inner, { max_attempts: Number.POSITIVE_INFINITY })).toThrow(
      'retry: max_attempts must be a finite number, got Infinity',
    )
    expect(() => retry(inner, { max_attempts: Number.NEGATIVE_INFINITY })).toThrow(
      'retry: max_attempts must be a finite number, got -Infinity',
    )
  })

  it('still accepts a finite max_attempts after the guard', async () => {
    // The guard must reject only non-finite values; an ordinary construction
    // and run stays exactly as before.
    const inner = step('ok', (n: number) => n + 1)
    const flow = retry(inner, { max_attempts: 2, backoff_ms: 1 })
    await expect(run(flow, 1, { install_signal_handlers: false })).resolves.toBe(2)
  })

  it('assigns each retry step a distinct retry_<n> id', () => {
    const a = retry(step('a', (n: number) => n), { max_attempts: 1 })
    const b = retry(step('b', (n: number) => n), { max_attempts: 1 })
    expect(a.id).toMatch(/^retry_\d+$/)
    expect(b.id).toMatch(/^retry_\d+$/)
    expect(a.id).not.toBe(b.id)
  })

  it('exposes a fully-specified resolved config as step metadata', () => {
    const inner = step('x', (n: number) => n)
    const full = retry(inner, {
      max_attempts: 4,
      backoff_ms: 20,
      max_delay_ms: 5_000,
      jitter: false,
      on_error: noop_on_error,
      name: 'my_retry',
    }).config
    expect(full?.['max_attempts']).toBe(4)
    expect(full?.['backoff_ms']).toBe(20)
    expect(full?.['max_delay_ms']).toBe(5_000)
    expect(full?.['jitter']).toBe(false)
    expect(full?.['on_error']).toBe(noop_on_error)
    expect(full?.['display_name']).toBe('my_retry')
  })

  it('defaults max_delay_ms to 30s and jitter to on (D9) in resolved config metadata', () => {
    const inner = step('x', (n: number) => n)
    const minimal = retry(inner, { max_attempts: 2 }).config
    expect(minimal?.['max_attempts']).toBe(2)
    expect(minimal?.['backoff_ms']).toBe(1000) // DEFAULT_BACKOFF_MS
    expect(minimal?.['max_delay_ms']).toBe(30_000) // DEFAULT_MAX_DELAY_MS
    expect(minimal?.['jitter']).toBe(true) // jitter defaults on (D9)
    expect('on_error' in (minimal ?? {})).toBe(false)
    expect('display_name' in (minimal ?? {})).toBe(false)
  })

  it('schedules each backoff as backoff_ms * 2^(attempt-1) with jitter disabled', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const inner = step('always_fail', (_: number) => {
        throw new Error('fail')
      })
      await expect(
        run(retry(inner, { max_attempts: 3, backoff_ms: 10, jitter: false }), 0, {
          install_signal_handlers: false,
        }),
      ).rejects.toThrow('fail')
      const delays = spy.mock.calls
        .map((c) => c[1])
        .filter((ms): ms is number => typeof ms === 'number')
      expect(delays).toEqual([10, 20])
    } finally {
      spy.mockRestore()
    }
  })

  it('jitters backoff by default and clamps it to max_delay_ms (D9)', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const real_set = globalThis.setTimeout
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void) => real_set(fn, 0)) as never)
    try {
      const inner = step('always_fail', (_: number) => {
        throw new Error('fail')
      })
      await expect(
        run(retry(inner, { max_attempts: 4, backoff_ms: 100, max_delay_ms: 300 }), 0, {
          install_signal_handlers: false,
        }),
      ).rejects.toThrow('fail')
      const delays = spy.mock.calls
        .map((c) => c[1])
        .filter((ms): ms is number => typeof ms === 'number')
      // base = 100 * 2^(attempt-1), + jitter (0.5*100=50), min(.., 300):
      // attempt1 -> 150, attempt2 -> 250, attempt3 -> min(450,300)=300
      expect(delays).toEqual([150, 250, 300])
    } finally {
      spy.mockRestore()
      vi.restoreAllMocks()
    }
  })

  it('checks the abort at the top of each attempt and skips the dispatch', async () => {
    let calls = 0
    const controller = new AbortController()
    const inner = step('x', (_: number) => {
      calls += 1
      controller.abort('cancelled') // abort after the first attempt
      throw new Error('fail')
    })
    // backoff_ms 0 means the wait returns without observing the abort, so the
    // loop-top guard is what stops attempt 2.
    const flow = retry(inner, { max_attempts: 3, backoff_ms: 0 })
    let err: unknown
    try {
      await run(flow, 0, { install_signal_handlers: false, abort: controller.signal })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).message).toBe('aborted')
    expect((err as aborted_error).reason).toBe('cancelled')
    expect(calls).toBe(1)
  })

  it('rejects at backoff entry when the abort is already set', async () => {
    let calls = 0
    const controller = new AbortController()
    const inner = step('x', (_: number) => {
      calls += 1
      controller.abort('cancelled')
      throw new Error('fail')
    })
    const flow = retry(inner, { max_attempts: 3, backoff_ms: 1000 })
    const started = performance.now()
    let err: unknown
    try {
      await run(flow, 0, { install_signal_handlers: false, abort: controller.signal })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).message).toBe('aborted')
    expect((err as aborted_error).reason).toBe('cancelled')
    // The entry guard must short-circuit; otherwise the 1000ms timer runs to
    // completion before the next loop-top check notices the abort.
    expect(performance.now() - started).toBeLessThan(500)
    expect(calls).toBe(1)
  })

  it('aborts a pending backoff instead of waiting it out', async () => {
    let calls = 0
    const controller = new AbortController()
    const inner = step('x', (_: number) => {
      calls += 1
      // Abort a few ms in, i.e. after the backoff timer + abort listener are
      // installed, so the listener (not the entry guard) is what fires.
      setTimeout(() => {
        controller.abort('cancelled')
      }, 5)
      throw new Error('fail')
    })
    const flow = retry(inner, { max_attempts: 3, backoff_ms: 1000 })
    const started = performance.now()
    let err: unknown
    try {
      await run(flow, 0, { install_signal_handlers: false, abort: controller.signal })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).message).toBe('aborted')
    expect((err as aborted_error).reason).toBe('cancelled')
    expect(performance.now() - started).toBeLessThan(500) // not the full 1000ms backoff
    expect(calls).toBe(1)
  })

  it('propagates an Error abort reason verbatim rather than wrapping it', async () => {
    const controller = new AbortController()
    // The shape the runner's signal handlers abort with, so this is what a
    // real SIGINT looks like to a retry sitting in a backoff.
    const sigint = new aborted_error('received SIGINT', { reason: { signal: 'SIGINT' } })
    const inner = step('x', (_: number) => {
      setTimeout(() => {
        controller.abort(sigint)
      }, 5)
      throw new Error('fail')
    })
    const flow = retry(inner, { max_attempts: 3, backoff_ms: 1000 })
    let err: unknown
    try {
      await run(flow, 0, { install_signal_handlers: false, abort: controller.signal })
    } catch (e) {
      err = e
    }
    // Core's abort shape, not the engine's: the same instance comes back, so
    // the upstream cause survives the retry. Wrapping would replace this
    // message with a bare 'aborted', and the runner's catch cannot repair that
    // (it only unwraps when the escaping error is not already an
    // aborted_error). See the note on to_abort_error in src/core/retry.ts.
    expect(err).toBe(sigint)
    expect((err as aborted_error).message).toBe('received SIGINT')
  })

  it('skips the timer entirely for a non-positive backoff', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const inner = step('x', (_: number) => {
        throw new Error('fail')
      })
      await expect(
        run(retry(inner, { max_attempts: 2, backoff_ms: 0 }), 0, { install_signal_handlers: false }),
      ).rejects.toThrow('fail')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('does not schedule a backoff after the final attempt', async () => {
    let calls = 0
    const controller = new AbortController()
    const inner = step('x', (_: number) => {
      calls += 1
      if (calls === 2) controller.abort('cancelled') // abort on the last attempt
      throw new Error('boom')
    })
    const flow = retry(inner, { max_attempts: 2, backoff_ms: 1 })
    // The final attempt must break out and rethrow its own error; if it instead
    // fell through to another backoff, the already-set abort would surface an
    // aborted_error instead of "boom".
    await expect(
      run(flow, 0, { install_signal_handlers: false, abort: controller.signal }),
    ).rejects.toThrow('boom')
    expect(calls).toBe(2)
  })
})
