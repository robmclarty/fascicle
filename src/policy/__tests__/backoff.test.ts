import { afterEach, describe, expect, it, vi } from 'vitest'

import { compute_backoff, wait_with_abort } from '#policy'
import type { BackoffPolicy } from '#policy'

const NO_JITTER: BackoffPolicy = {
  initial_delay_ms: 100,
  max_delay_ms: 30_000,
  jitter: false,
}

const WITH_JITTER: BackoffPolicy = { ...NO_JITTER, jitter: true }

class test_abort_error extends Error {
  readonly reason: unknown

  constructor(reason: unknown) {
    super('aborted')
    this.name = 'test_abort_error'
    this.reason = reason
  }
}

const to_error = (reason: unknown): Error => new test_abort_error(reason)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('compute_backoff', () => {
  it('doubles from the initial delay on each attempt, counting from zero', () => {
    expect(compute_backoff(NO_JITTER, 0)).toBe(100)
    expect(compute_backoff(NO_JITTER, 1)).toBe(200)
    expect(compute_backoff(NO_JITTER, 2)).toBe(400)
    expect(compute_backoff(NO_JITTER, 3)).toBe(800)
  })

  it('adds no jitter when jitter is off, however Math.random falls', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    expect(compute_backoff(NO_JITTER, 1)).toBe(200)
  })

  it('adds up to one initial delay of jitter when jitter is on', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(compute_backoff(WITH_JITTER, 1)).toBe(250)
  })

  it('keeps jittered delays inside [base, base + initial_delay_ms)', () => {
    const samples = Array.from({ length: 50 }, () => compute_backoff(WITH_JITTER, 2))
    for (const delay of samples) {
      expect(delay).toBeGreaterThanOrEqual(400)
      expect(delay).toBeLessThan(500)
    }
    expect(new Set(samples).size).toBeGreaterThan(1)
  })

  it('clamps to max_delay_ms once the exponential passes the cap', () => {
    const capped: BackoffPolicy = { initial_delay_ms: 100, max_delay_ms: 500, jitter: false }
    expect(compute_backoff(capped, 2)).toBe(400)
    expect(compute_backoff(capped, 3)).toBe(500)
    expect(compute_backoff(capped, 20)).toBe(500)
  })

  it('clamps the jitter too, so a jittered delay never exceeds the cap', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const capped: BackoffPolicy = { initial_delay_ms: 100, max_delay_ms: 450, jitter: true }
    expect(compute_backoff(capped, 2)).toBe(450)
  })

  it('treats an infinite max_delay_ms as uncapped', () => {
    const uncapped: BackoffPolicy = {
      initial_delay_ms: 100,
      max_delay_ms: Number.POSITIVE_INFINITY,
      jitter: false,
    }
    expect(compute_backoff(uncapped, 20)).toBe(100 * 2 ** 20)
  })
})

describe('wait_with_abort', () => {
  it('resolves after the delay when nothing aborts', async () => {
    const controller = new AbortController()
    const started = Date.now()
    await wait_with_abort(20, controller.signal, to_error)
    expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  })

  it('rejects with the mapped reason when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort('cancelled')
    const err = await wait_with_abort(5_000, controller.signal, to_error).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(test_abort_error)
    expect((err as test_abort_error).reason).toBe('cancelled')
  })

  it('rejects promptly when abort fires mid-wait, without serving out the delay', async () => {
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort('cancelled'), 10)
    const err = await wait_with_abort(5_000, controller.signal, to_error).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(test_abort_error)
    expect((err as test_abort_error).reason).toBe('cancelled')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('clears the pending timer when abort fires mid-wait', async () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const controller = new AbortController()
    setTimeout(() => controller.abort('cancelled'), 10)
    await wait_with_abort(5_000, controller.signal, to_error).catch(() => undefined)
    expect(clear).toHaveBeenCalled()
  })

  it('drops its abort listener once the delay is served', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await wait_with_abort(10, controller.signal, to_error)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('maps an Error abort reason through the factory like any other', async () => {
    const controller = new AbortController()
    const reason = new Error('boom')
    controller.abort(reason)
    const err = await wait_with_abort(5_000, controller.signal, to_error).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(test_abort_error)
    expect((err as test_abort_error).reason).toBe(reason)
  })

  it('resolves a non-positive delay without arming a timer or reading the signal', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const controller = new AbortController()
    controller.abort('cancelled')
    await expect(wait_with_abort(0, controller.signal, to_error)).resolves.toBeUndefined()
    await expect(wait_with_abort(-1, controller.signal, to_error)).resolves.toBeUndefined()
    expect(timer).not.toHaveBeenCalled()
  })
})
