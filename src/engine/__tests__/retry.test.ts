import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RETRY,
  parse_retry_after,
  retry_with_policy,
} from '../retry.js'
import { aborted_error, provider_error, rate_limit_error } from '../errors.js'
import type { RetryPolicy } from '../types.js'

const FAST_POLICY: RetryPolicy = {
  max_attempts: 3,
  initial_delay_ms: 10,
  max_delay_ms: 100,
  retry_on: ['rate_limit', 'provider_5xx', 'network'],
}

describe('DEFAULT_RETRY', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_RETRY.max_attempts).toBe(3)
    expect(DEFAULT_RETRY.initial_delay_ms).toBe(500)
    expect(DEFAULT_RETRY.max_delay_ms).toBe(30_000)
    expect(DEFAULT_RETRY.retry_on).toEqual(['rate_limit', 'provider_5xx', 'network', 'timeout'])
  })
})

describe('parse_retry_after', () => {
  it('parses numeric seconds into ms', () => {
    expect(parse_retry_after('2')).toBe(2000)
    expect(parse_retry_after('0.5')).toBe(500)
  })

  it('parses HTTP-date forms into ms from now', () => {
    const future = new Date(Date.now() + 3000).toUTCString()
    const result = parse_retry_after(future)
    expect(result).toBeDefined()
    expect(result!).toBeGreaterThanOrEqual(2000)
    expect(result!).toBeLessThanOrEqual(3500)
  })

  it('returns undefined for null/empty/invalid', () => {
    expect(parse_retry_after(null)).toBeUndefined()
    expect(parse_retry_after(undefined)).toBeUndefined()
    expect(parse_retry_after('')).toBeUndefined()
    expect(parse_retry_after('not-a-date')).toBeUndefined()
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(parse_retry_after('  2  ')).toBe(2000)
    expect(parse_retry_after('   ')).toBeUndefined()
  })

  it('only treats a fully-numeric trimmed string as seconds (anchored, multi-digit)', () => {
    expect(parse_retry_after('30')).toBe(30000) // multi-digit
    expect(parse_retry_after('12abc')).toBeUndefined() // trailing junk -> not a Date either
    expect(parse_retry_after('abc12')).toBeUndefined() // leading junk
  })
})

describe('retry_with_policy', () => {
  it('returns the value on first success', async () => {
    const result = await retry_with_policy(async () => 42, FAST_POLICY)
    expect(result).toBe(42)
  })

  it('retries 429 with numeric Retry-After and waits at least that long', async () => {
    let attempts = 0
    const start = Date.now()
    const result = await retry_with_policy(async () => {
      attempts += 1
      if (attempts < 2) {
        throw { kind: 'rate_limit', retry_after_ms: 200, status: 429 }
      }
      return 'ok'
    }, FAST_POLICY)
    const elapsed = Date.now() - start
    expect(result).toBe('ok')
    expect(attempts).toBe(2)
    expect(elapsed).toBeGreaterThanOrEqual(180)
  })

  it('retries 5xx with exponential backoff bounded by max_delay_ms', async () => {
    let attempts = 0
    const start = Date.now()
    const result = await retry_with_policy(async () => {
      attempts += 1
      if (attempts < 3) throw { kind: 'provider_5xx', status: 503 }
      return 'ok'
    }, FAST_POLICY)
    const elapsed = Date.now() - start
    expect(result).toBe('ok')
    expect(attempts).toBe(3)
    expect(elapsed).toBeLessThan(FAST_POLICY.max_delay_ms * FAST_POLICY.max_attempts + 500)
  })

  it('rejects with aborted_error when abort fires during wait', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    let attempts = 0
    await expect(
      retry_with_policy(
        async () => {
          attempts += 1
          throw { kind: 'rate_limit', retry_after_ms: 1000 }
        },
        { ...FAST_POLICY, max_attempts: 5 },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(aborted_error)
    expect(attempts).toBe(1)
  })

  it('does not retry 4xx failures outside rate_limit', async () => {
    let attempts = 0
    const fail = new Error('bad request')
    await expect(
      retry_with_policy(
        async () => {
          attempts += 1
          throw fail
        },
        FAST_POLICY,
      ),
    ).rejects.toBe(fail)
    expect(attempts).toBe(1)
  })

  it('throws rate_limit_error after max_attempts', async () => {
    let attempts = 0
    try {
      await retry_with_policy(async () => {
        attempts += 1
        throw { kind: 'rate_limit', status: 429, retry_after_ms: 10 }
      }, FAST_POLICY)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(rate_limit_error)
      expect((err as rate_limit_error).attempts).toBe(FAST_POLICY.max_attempts)
    }
    expect(attempts).toBe(FAST_POLICY.max_attempts)
  })

  it('throws provider_error after max_attempts for 5xx', async () => {
    try {
      await retry_with_policy(async () => {
        throw { kind: 'provider_5xx', status: 500, body: 'boom' }
      }, FAST_POLICY)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(provider_error)
      expect((err as provider_error).status).toBe(500)
      expect((err as provider_error).cause_kind).toBe('provider_5xx')
    }
  })

  it('throws provider_error after max_attempts for network kind', async () => {
    try {
      await retry_with_policy(async () => {
        throw { kind: 'network', message: 'ECONNRESET' }
      }, FAST_POLICY)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(provider_error)
      expect((err as provider_error).cause_kind).toBe('network')
    }
  })

  it('computes exponential backoff with jitter, capped at max_delay_ms', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const real_set = globalThis.setTimeout
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void) => real_set(fn, 0)) as never)
    try {
      await expect(
        retry_with_policy(
          async () => {
            throw { kind: 'network' }
          },
          { initial_delay_ms: 100, max_delay_ms: 300, max_attempts: 4, retry_on: ['network'] },
        ),
      ).rejects.toBeInstanceOf(provider_error)
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

  it('rejects at wait entry without serving the backoff when abort is already set', async () => {
    const controller = new AbortController()
    const start = Date.now()
    let err: unknown
    try {
      await retry_with_policy(
        async () => {
          controller.abort('cancelled')
          throw { kind: 'rate_limit', retry_after_ms: 1000 }
        },
        { ...FAST_POLICY, max_attempts: 5 },
        controller.signal,
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).message).toBe('aborted')
    expect((err as aborted_error).reason).toBe('cancelled')
    expect(Date.now() - start).toBeLessThan(500) // did not serve the 1000ms wait
  })

  it('rate_limit_error carries status, retry_after_ms, and a custom message', async () => {
    let err: unknown
    try {
      // max_attempts 1 exhausts before any backoff, so last_rate_limit_after
      // stays undefined and retry_after_ms must come from the retryable itself.
      await retry_with_policy(async () => {
        throw { kind: 'rate_limit', status: 429, retry_after_ms: 7, message: 'slow down' }
      }, { ...FAST_POLICY, max_attempts: 1 })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(rate_limit_error)
    expect((err as rate_limit_error).status).toBe(429)
    expect((err as rate_limit_error).retry_after_ms).toBe(7)
    expect((err as rate_limit_error).message).toBe('slow down')
  })

  it('rate_limit_error falls back to a default message and a prior retry_after', async () => {
    let attempts = 0
    let err: unknown
    try {
      await retry_with_policy(async () => {
        attempts += 1
        // First failure carries Retry-After; later ones do not.
        if (attempts === 1) throw { kind: 'rate_limit', retry_after_ms: 5 }
        throw { kind: 'rate_limit' }
      }, FAST_POLICY)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(rate_limit_error)
    expect((err as rate_limit_error).message).toBe(`rate limited after ${FAST_POLICY.max_attempts} attempts`)
    expect((err as rate_limit_error).retry_after_ms).toBe(5) // carried from the first failure
    expect('status' in (err as object)).toBe(true) // field declared; value undefined here
  })

  it('provider_error carries 5xx status and body, or a default message', async () => {
    let err: unknown
    try {
      await retry_with_policy(async () => {
        throw { kind: 'provider_5xx', status: 503, body: 'Service Unavailable' }
      }, FAST_POLICY)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_error)
    expect((err as provider_error).status).toBe(503)
    expect((err as provider_error).body).toBe('Service Unavailable')
    expect((err as provider_error).cause_kind).toBe('provider_5xx')
    expect((err as provider_error).message).toBe(`provider_5xx after ${FAST_POLICY.max_attempts} attempts`)
  })

  it('provider_error preserves a custom 5xx message over the default', async () => {
    let err: unknown
    try {
      await retry_with_policy(async () => {
        throw { kind: 'provider_5xx', status: 500, message: 'upstream is on fire' }
      }, { ...FAST_POLICY, max_attempts: 1 })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_error)
    expect((err as provider_error).message).toBe('upstream is on fire')
  })

  it('retries and exhausts a timeout kind into a network-cause provider_error', async () => {
    const policy: RetryPolicy = { ...FAST_POLICY, retry_on: ['timeout'], max_attempts: 1 }
    let err: unknown
    try {
      await retry_with_policy(async () => {
        throw { kind: 'timeout', message: 'deadline exceeded' }
      }, policy)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_error)
    expect((err as provider_error).cause_kind).toBe('network')
    expect((err as provider_error).message).toBe('deadline exceeded')
  })

  it('network exhaustion does not attach status or body', async () => {
    let err: unknown
    try {
      await retry_with_policy(async () => {
        throw { kind: 'network', message: 'ECONNRESET' }
      }, FAST_POLICY)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_error)
    expect((err as provider_error).cause_kind).toBe('network')
    expect((err as provider_error).message).toBe('ECONNRESET') // custom message preserved
    expect((err as provider_error).body).toBeUndefined()
  })

  it('throws at the loop top without calling fn when pre-aborted', async () => {
    const controller = new AbortController()
    controller.abort('cancelled')
    let calls = 0
    let err: unknown
    try {
      await retry_with_policy(
        async () => {
          calls += 1
          return 1
        },
        FAST_POLICY,
        controller.signal,
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).message).toBe('aborted')
    expect((err as aborted_error).reason).toBe('cancelled')
    expect(calls).toBe(0)
  })

  it('cancels a pending backoff via the abort listener (prompt rejection)', async () => {
    const controller = new AbortController()
    const start = Date.now()
    let attempts = 0
    let err: unknown
    try {
      await retry_with_policy(
        async () => {
          attempts += 1
          setTimeout(() => {
            controller.abort('cancelled')
          }, 5)
          throw { kind: 'rate_limit', retry_after_ms: 1000 }
        },
        { ...FAST_POLICY, max_attempts: 5 },
        controller.signal,
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).message).toBe('aborted')
    expect((err as aborted_error).reason).toBe('cancelled')
    expect(Date.now() - start).toBeLessThan(500)
    expect(attempts).toBe(1)
  })

  it('rethrows a thrown null without misclassifying it', async () => {
    let err: unknown
    let threw = false
    try {
      await retry_with_policy(async () => {
        throw null
      }, FAST_POLICY)
    } catch (e) {
      threw = true
      err = e
    }
    expect(threw).toBe(true)
    expect(err).toBeNull()
  })

  it('does not retry a failure class absent from retry_on', async () => {
    const policy: RetryPolicy = { ...FAST_POLICY, retry_on: ['rate_limit'] }
    let attempts = 0
    try {
      await retry_with_policy(async () => {
        attempts += 1
        throw { kind: 'provider_5xx', status: 503 }
      }, policy)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as { kind?: string }).kind).toBe('provider_5xx')
    }
    expect(attempts).toBe(1)
  })
})
