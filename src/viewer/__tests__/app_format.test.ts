import { describe, expect, it } from 'vitest'
import {
  RUN_ID_PLACEHOLDER,
  event_count_word,
  short_run_id,
} from '../app/lib/format.js'

describe('short_run_id', () => {
  it('keeps the first eight characters of a uuid', () => {
    expect(short_run_id('42b20e54-41e6-47b2-8697-bda677867762')).toBe('42b20e54')
  })

  it('leaves an id shorter than the slot alone', () => {
    expect(short_run_id('abc')).toBe('abc')
    expect(short_run_id('')).toBe('')
  })

  it('keeps exactly eight characters, not seven or nine', () => {
    expect(short_run_id('0123456789')).toHaveLength(8)
    expect(short_run_id('0123456789')).toBe('01234567')
  })
})

describe('RUN_ID_PLACEHOLDER', () => {
  it('fills the same eight-character slot the real id will', () => {
    expect(RUN_ID_PLACEHOLDER).toHaveLength(8)
    expect(RUN_ID_PLACEHOLDER).toBe('········')
  })
})

describe('event_count_word', () => {
  it('is singular only at one', () => {
    expect(event_count_word(1)).toBe('EVENT')
    expect(event_count_word(0)).toBe('EVENTS')
    expect(event_count_word(2)).toBe('EVENTS')
    expect(event_count_word(41)).toBe('EVENTS')
  })
})
