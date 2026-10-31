import { describe, expect, it } from 'vitest'

import { failure_meta } from '#policy'

describe('failure_meta', () => {
  it('copies status, attempts, cause_kind, and retry_after_ms into their error_ fields', () => {
    const err = Object.assign(new Error('x'), { status: 503, attempts: 4, cause_kind: 'provider_5xx', retry_after_ms: 2000 })
    expect(failure_meta(err)).toStrictEqual({
      error_status: 503,
      error_attempts: 4,
      error_cause_kind: 'provider_5xx',
      error_retry_after_ms: 2000,
    })
  })

  it('keeps each field only when it holds the expected type', () => {
    expect(failure_meta({ status: '503', attempts: undefined, cause_kind: 1, retry_after_ms: null })).toStrictEqual({})
    expect(failure_meta({ status: 429 })).toStrictEqual({ error_status: 429 })
    expect(failure_meta({ attempts: 2 })).toStrictEqual({ error_attempts: 2 })
    expect(failure_meta({ cause_kind: 'network' })).toStrictEqual({ error_cause_kind: 'network' })
    expect(failure_meta({ retry_after_ms: 0 })).toStrictEqual({ error_retry_after_ms: 0 })
  })

  it('reads nothing off a value that is not an object', () => {
    for (const value of [null, undefined, 'boom', 42]) expect(failure_meta(value)).toStrictEqual({})
  })
})
