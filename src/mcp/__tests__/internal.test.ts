import { describe, expect, it } from 'vitest'
import { as_record, is_record } from '../internal.js'

describe('is_record', () => {
  it('accepts only non-null, non-array objects', () => {
    expect(is_record({})).toBe(true)
    expect(is_record({ a: 1 })).toBe(true)
    expect(is_record(null)).toBe(false)
    expect(is_record([])).toBe(false)
    expect(is_record('s')).toBe(false)
    expect(is_record(7)).toBe(false)
    expect(is_record(undefined)).toBe(false)
  })
})

describe('as_record', () => {
  it('returns the value when it is a record and undefined otherwise', () => {
    expect(as_record({ a: 1 })).toEqual({ a: 1 })
    expect(as_record(null)).toBeUndefined()
    expect(as_record([1])).toBeUndefined()
    expect(as_record('x')).toBeUndefined()
  })
})
