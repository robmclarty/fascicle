import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RETRY,
  parse_retry_after,
  retry_with_policy,
  type RetryAttemptInfo,
} from '../retry.js'
import { aborted_error, provider_error, rate_limit_error, turn_timeout_error } from '../errors.js'
import { network_failure } from '../providers/native_shared.js'
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

  it('wraps a bare abort, whose reason is a DOMException, not an aborted_error', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    let err: unknown
    try {
      await retry_with_policy(
        async () => {
          throw { kind: 'rate_limit', retry_after_ms: 1000 }
        },
        { ...FAST_POLICY, max_attempts: 5 },
        controller.signal,
      )
    } catch (e) {
      err = e
    }
    // The engine's abort shape, and the reason it cannot adopt core's
    // propagate-an-Error-verbatim rule: a bare abort() sets signal.reason to a
    // DOMException, which IS instanceof Error, so propagating would leak a
    // non-fascicle error out of a boundary documented as throwing
    // aborted_error. See to_abort_error in src/engine/retry.ts.
    expect(err).toBeInstanceOf(aborted_error)
    expect((err as aborted_error).reason).toBeInstanceOf(Error)
    expect((err as aborted_error).reason).not.toBeInstanceOf(aborted_error)
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

  it('rate_limit_error carries status, retry_after_ms, and the provider message after its lead', async () => {
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
    expect((err as rate_limit_error).message).toBe('rate limited after 1 attempt (status 429): slow down')
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
    expect((err as provider_error).message).toBe(`provider_5xx after ${FAST_POLICY.max_attempts} attempts (status 503)`)
  })

  it('provider_error ends its message with the provider message', async () => {
    let err: unknown
    try {
      await retry_with_policy(async () => {
        throw { kind: 'provider_5xx', status: 500, message: 'upstream is on fire' }
      }, { ...FAST_POLICY, max_attempts: 1 })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(provider_error)
    expect((err as provider_error).message).toBe('provider_5xx after 1 attempt (status 500): upstream is on fire')
  })

  it('provider_error leaves the status out of a 5xx message that had none', async () => {
    const err = await retry_with_policy(async () => {
      throw { kind: 'provider_5xx', message: 'upstream is on fire' }
    }, { ...FAST_POLICY, max_attempts: 2 }).catch((e: unknown) => e)
    expect((err as provider_error).message).toBe('provider_5xx after 2 attempts: upstream is on fire')
    expect((err as provider_error).status).toBeUndefined()
  })

  it('an exhausted 5xx counts its attempts and keeps the original error as its cause', async () => {
    const original = new Error('Bedrock is unable to process your request.')
    const err = await retry_with_policy(async () => {
      throw { kind: 'provider_5xx', status: 503, body: '{"message":"x"}', message: 'x', cause: original }
    }, FAST_POLICY).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_error)
    expect(err).toMatchObject({ status: 503, body: '{"message":"x"}', attempts: FAST_POLICY.max_attempts })
    expect((err as provider_error).cause).toBe(original)
  })

  it('an exhausted 429 keeps the original error as its cause', async () => {
    const original = new Error('Too Many Requests')
    const err = await retry_with_policy(async () => {
      throw { kind: 'rate_limit', status: 429, cause: original }
    }, FAST_POLICY).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(rate_limit_error)
    expect((err as rate_limit_error).cause).toBe(original)
  })

  it('a record with no cause leaves the typed error without one', async () => {
    const err = await retry_with_policy(async () => {
      throw { kind: 'provider_5xx', status: 500 }
    }, { ...FAST_POLICY, max_attempts: 1 }).catch((e: unknown) => e)
    expect((err as provider_error).cause).toBeUndefined()
  })

  it('an exhausted failure that is already an Error is the cause itself', async () => {
    const timeout = new turn_timeout_error(50)
    const err = await retry_with_policy(async () => {
      throw timeout
    }, { ...FAST_POLICY, retry_on: ['timeout'], max_attempts: 1 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(provider_error)
    expect(err).toMatchObject({ cause_kind: 'network', attempts: 1 })
    expect((err as provider_error).cause).toBe(timeout)
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
    expect((err as provider_error).message).toBe('timeout after 1 attempt: deadline exceeded')
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
    expect((err as provider_error).message).toBe(`network after ${FAST_POLICY.max_attempts} attempts: ECONNRESET`)
    expect((err as provider_error).body).toBeUndefined()
    expect((err as provider_error).status).toBeUndefined()
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
      expect(err).toBeInstanceOf(provider_error)
      expect((err as provider_error).cause_kind).toBe('provider_5xx')
    }
    expect(attempts).toBe(1)
  })
})

describe('retry_with_policy: a failure that retry_on leaves out', () => {
  const NONE: RetryPolicy = { ...FAST_POLICY, retry_on: [] }

  // What the call rejected with, after one failing attempt that throws `thrown`.
  function rejection(thrown: unknown, policy: RetryPolicy = NONE): Promise<unknown> {
    return retry_with_policy(async () => {
      throw thrown
    }, policy).then(
      () => 'resolved',
      (err: unknown) => err,
    )
  }

  it('throws provider_error for a 5xx record, with its status, body, and message', async () => {
    const err = await rejection({ kind: 'provider_5xx', status: 503, body: 'overloaded', message: 'Service Unavailable' })
    expect(err).toBeInstanceOf(provider_error)
    expect(err).toMatchObject({
      status: 503,
      body: 'overloaded',
      cause_kind: 'provider_5xx',
      attempts: 1,
      message: 'provider_5xx left out of retry_on (status 503): Service Unavailable',
    })
  })

  it('keeps the original error as the cause of a record it leaves out', async () => {
    const original = new Error('Service Unavailable')
    const err = await rejection({ kind: 'provider_5xx', status: 503, cause: original })
    expect((err as provider_error).cause).toBe(original)
  })

  it('throws rate_limit_error for a 429 record, with one attempt and its status', async () => {
    const err = await rejection({ kind: 'rate_limit', status: 429, retry_after_ms: 2000, message: 'Too Many Requests' })
    expect(err).toBeInstanceOf(rate_limit_error)
    expect(err).toMatchObject({
      attempts: 1,
      status: 429,
      retry_after_ms: 2000,
      message: 'rate_limit left out of retry_on (status 429): Too Many Requests',
    })
  })

  it.each(['network', 'timeout'] as const)('throws provider_error with cause_kind network for a %s record', async (kind) => {
    const err = await rejection({ kind, message: 'socket hang up' })
    expect(err).toBeInstanceOf(provider_error)
    expect(err).toMatchObject({ cause_kind: 'network', status: undefined, message: `${kind} left out of retry_on: socket hang up` })
  })

  it.each(['rate_limit', 'provider_5xx', 'network'] as const)(
    'says that retry_on leaves a %s record without a message out, and never counts attempts',
    async (kind) => {
      const err = await rejection({ kind })
      expect((err as Error).message).toBe(`${kind} left out of retry_on`)
    },
  )

  it.each([
    ['turn_timeout_error', new turn_timeout_error(50)],
    ['network_failure', network_failure('connection reset')],
  ])('rethrows a %s as itself', async (_, thrown) => {
    expect(await rejection(thrown)).toBe(thrown)
  })

  it('counts every failure so far when one it retried is followed by one it leaves out', async () => {
    const policy: RetryPolicy = { ...FAST_POLICY, retry_on: ['provider_5xx'] }
    const failures: unknown[] = [{ kind: 'provider_5xx', status: 503 }, { kind: 'rate_limit', status: 429 }]
    const err = await retry_with_policy(async () => {
      throw failures.shift()
    }, policy).then(
      () => 'resolved',
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(rate_limit_error)
    expect(err).toMatchObject({ attempts: 2, status: 429 })
  })
})

function collecting(): { infos: RetryAttemptInfo[]; on_retry: (i: RetryAttemptInfo) => void } {
  const infos: RetryAttemptInfo[] = []
  return { infos, on_retry: (i) => infos.push(i) }
}

describe('retry_with_policy on_retry reporting', () => {
  const ZERO_DELAY: RetryPolicy = {
    max_attempts: 3,
    initial_delay_ms: 0,
    max_delay_ms: 0,
    retry_on: ['rate_limit', 'provider_5xx', 'network', 'timeout'],
  }

  it('reports a rate limit with status and the honored Retry-After as the delay', async () => {
    const { infos, on_retry } = collecting()
    let calls = 0
    const result = await retry_with_policy(
      async () => {
        calls += 1
        if (calls === 1) {
          throw { kind: 'rate_limit', status: 429, retry_after_ms: 25, message: 'slow down' }
        }
        return 'ok'
      },
      ZERO_DELAY,
      undefined,
      on_retry,
    )
    expect(result).toBe('ok')
    // Retry-After outranks the zero local backoff, so delay_ms is the header's.
    expect(infos).toEqual([
      {
        attempt: 1,
        failure_kind: 'rate_limit',
        delay_ms: 25,
        status: 429,
        retry_after_ms: 25,
      },
    ])
  })

  it('reports a 5xx with its status and no retry_after_ms key', async () => {
    const { infos, on_retry } = collecting()
    let calls = 0
    await retry_with_policy(
      async () => {
        calls += 1
        if (calls === 1) throw { kind: 'provider_5xx', status: 503, message: 'unavailable' }
        return 'ok'
      },
      ZERO_DELAY,
      undefined,
      on_retry,
    )
    expect(infos).toStrictEqual([
      { attempt: 1, failure_kind: 'provider_5xx', delay_ms: 0, status: 503 },
    ])
  })

  it('reports network and timeout failures with the kind alone', async () => {
    const { infos, on_retry } = collecting()
    let calls = 0
    await retry_with_policy(
      async () => {
        calls += 1
        if (calls === 1) throw { kind: 'network', message: 'reset' }
        if (calls === 2) throw { kind: 'timeout', message: 'deadline' }
        return 'ok'
      },
      ZERO_DELAY,
      undefined,
      on_retry,
    )
    expect(infos).toStrictEqual([
      { attempt: 1, failure_kind: 'network', delay_ms: 0 },
      { attempt: 2, failure_kind: 'timeout', delay_ms: 0 },
    ])
  })

  it('never fires for a first-attempt success or a non-retryable failure', async () => {
    const { infos, on_retry } = collecting()
    await retry_with_policy(async () => 'fine', ZERO_DELAY, undefined, on_retry)
    await expect(
      retry_with_policy(
        async () => {
          throw new Error('permanent')
        },
        ZERO_DELAY,
        undefined,
        on_retry,
      ),
    ).rejects.toThrow('permanent')
    expect(infos).toEqual([])
  })

  it('does not fire for the final failure that exhausts the policy', async () => {
    const { infos, on_retry } = collecting()
    const exhausting: RetryPolicy = { ...ZERO_DELAY, max_attempts: 2 }
    await expect(
      retry_with_policy(
        async () => {
          throw { kind: 'network', message: 'reset' }
        },
        exhausting,
        undefined,
        on_retry,
      ),
    ).rejects.toThrow(provider_error)
    // Two attempts ran, but only the first failure retried; the second threw.
    expect(infos).toEqual([{ attempt: 1, failure_kind: 'network', delay_ms: 0 }])
  })
})

describe('retry_with_policy honors a 5xx Retry-After', () => {
  const ZERO_DELAY: RetryPolicy = {
    max_attempts: 3,
    initial_delay_ms: 0,
    max_delay_ms: 0,
    retry_on: ['rate_limit', 'provider_5xx', 'network'],
  }

  it('waits at least the server\'s two seconds before retrying a 503', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      const infos: RetryAttemptInfo[] = []
      const pending = retry_with_policy(
        async () => {
          attempts += 1
          if (attempts === 1) throw { kind: 'provider_5xx', status: 503, retry_after_ms: 2000 }
          return 'ok'
        },
        ZERO_DELAY,
        undefined,
        (info) => infos.push(info),
      )
      await vi.advanceTimersByTimeAsync(1999)
      expect(attempts).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toBe('ok')
      expect(attempts).toBe(2)
      expect(infos).toEqual([
        { attempt: 1, failure_kind: 'provider_5xx', delay_ms: 2000, status: 503, retry_after_ms: 2000 },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets an abort interrupt the wait', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      let attempts = 0
      const pending = retry_with_policy(
        async () => {
          attempts += 1
          throw { kind: 'provider_5xx', status: 503, retry_after_ms: 2000 }
        },
        ZERO_DELAY,
        controller.signal,
      )
      const settled = expect(pending).rejects.toBeInstanceOf(aborted_error)
      await vi.advanceTimersByTimeAsync(500)
      controller.abort()
      await settled
      expect(attempts).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a 5xx Retry-After but keeps it off a later rate limit that carries none', async () => {
    let attempts = 0
    const failures = [
      { kind: 'provider_5xx', status: 503, retry_after_ms: 1 },
      { kind: 'rate_limit', status: 429 },
    ]
    const infos: RetryAttemptInfo[] = []
    const error = await retry_with_policy(
      async () => {
        attempts += 1
        throw failures[attempts - 1]
      },
      { ...ZERO_DELAY, max_attempts: 2 },
      undefined,
      (info) => infos.push(info),
    ).catch((err: unknown) => err)
    expect(infos).toEqual([
      { attempt: 1, failure_kind: 'provider_5xx', delay_ms: 1, status: 503, retry_after_ms: 1 },
    ])
    expect(error).toBeInstanceOf(rate_limit_error)
    expect((error as rate_limit_error).retry_after_ms).toBeUndefined()
  })
})
