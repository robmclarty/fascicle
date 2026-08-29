import { describe, expect, it } from 'vitest'
import {
  RUN_ID_PLACEHOLDER,
  format_cost,
  format_duration,
  format_header_stats,
  format_t_plus,
  header_stat_parts,
  retry_word,
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

describe('header_stat_parts', () => {
  it('tags the artboard-06 zero line with the roles the opacities key off', () => {
    expect(
      header_stat_parts({ t_plus_ms: 0, retries_absorbed: 0, scars: 0, cost_usd: 0 }),
    ).toEqual([
      { text: 'T+0MS', role: 'value' },
      { text: '·', role: 'sep' },
      { text: '0', role: 'value' },
      { text: 'RETRIES ABSORBED', role: 'word' },
      { text: '·', role: 'sep' },
      { text: 'SCARS', role: 'word' },
      { text: '0', role: 'value' },
      { text: '·', role: 'sep' },
      { text: '$0.0000', role: 'value' },
    ])
  })

  it('draws the scar numeral in ember once a scar exists (artboard 04)', () => {
    const parts = header_stat_parts({
      t_plus_ms: 412,
      retries_absorbed: 1,
      scars: 1,
      cost_usd: 0.0018,
    })
    const scar = parts.find((part) => part.text === '1' && part.role === 'scar')
    expect(scar).toEqual({ text: '1', role: 'scar' })
    // The zero line keeps the plain value role, so ember never reaches a
    // scar-free header.
    const zero = header_stat_parts({
      t_plus_ms: 0,
      retries_absorbed: 0,
      scars: 0,
      cost_usd: 0,
    })
    expect(zero.some((part) => part.role === 'scar')).toBe(false)
  })

  it('carries the artboard-01 mid-run values through the same slots', () => {
    const texts = header_stat_parts({
      t_plus_ms: 130,
      retries_absorbed: 1,
      scars: 0,
      cost_usd: 0,
    }).map((part) => part.text)
    expect(texts).toEqual([
      'T+130MS',
      '·',
      '1',
      'RETRY ABSORBED',
      '·',
      'SCARS',
      '0',
      '·',
      '$0.0000',
    ])
  })
})

describe('format_t_plus', () => {
  it('reads in milliseconds under a second', () => {
    expect(format_t_plus(0)).toBe('T+0MS')
    expect(format_t_plus(130)).toBe('T+130MS')
    expect(format_t_plus(999)).toBe('T+999MS')
  })

  it('reads in centisecond-truncated seconds under a minute', () => {
    expect(format_t_plus(1000)).toBe('T+1.00S')
    expect(format_t_plus(1239)).toBe('T+1.23S')
    expect(format_t_plus(59_999)).toBe('T+59.99S')
  })

  it('reads in minutes and whole seconds from a minute up', () => {
    expect(format_t_plus(60_000)).toBe('T+1M00S')
    expect(format_t_plus(61_000)).toBe('T+1M01S')
    expect(format_t_plus(602_500)).toBe('T+10M02S')
  })

  it('truncates fractions and clamps a negative offset to zero', () => {
    expect(format_t_plus(130.9)).toBe('T+130MS')
    expect(format_t_plus(-5)).toBe('T+0MS')
  })
})

describe('format_duration', () => {
  it('names the artboard-01 node spans the way the metas print them', () => {
    expect(format_duration(42)).toBe('42MS')
    expect(format_duration(0)).toBe('0MS')
    expect(format_duration(31)).toBe('31MS')
  })

  it('changes units exactly where the header clock does', () => {
    expect(format_duration(999)).toBe('999MS')
    expect(format_duration(1000)).toBe('1.00S')
    expect(format_duration(59_999)).toBe('59.99S')
    expect(format_duration(60_000)).toBe('1M00S')
  })

  it('truncates fractions and clamps a negative span to zero', () => {
    expect(format_duration(42.9)).toBe('42MS')
    expect(format_duration(-1)).toBe('0MS')
  })
})

describe('format_cost', () => {
  it('shows four decimals under one cent', () => {
    expect(format_cost(0)).toBe('$0.0000')
    expect(format_cost(0.0042)).toBe('$0.0042')
    expect(format_cost(0.0099)).toBe('$0.0099')
  })

  it('shows two decimals from one cent up', () => {
    expect(format_cost(0.01)).toBe('$0.01')
    expect(format_cost(1.5)).toBe('$1.50')
    expect(format_cost(12.345)).toBe('$12.35')
  })
})

describe('retry_word', () => {
  it('is singular only at one', () => {
    expect(retry_word(1)).toBe('RETRY')
    expect(retry_word(0)).toBe('RETRIES')
    expect(retry_word(2)).toBe('RETRIES')
  })
})

describe('format_header_stats', () => {
  it('reproduces the artboard-01 reference line', () => {
    expect(
      format_header_stats({
        t_plus_ms: 130,
        retries_absorbed: 1,
        scars: 0,
        cost_usd: 0,
      }),
    ).toBe('T+130MS · 1 RETRY ABSORBED · SCARS 0 · $0.0000')
  })

  it('pluralizes and re-formats each slot as the numbers grow', () => {
    expect(
      format_header_stats({
        t_plus_ms: 1239,
        retries_absorbed: 2,
        scars: 1,
        cost_usd: 0.0123,
      }),
    ).toBe('T+1.23S · 2 RETRIES ABSORBED · SCARS 1 · $0.01')
  })
})
