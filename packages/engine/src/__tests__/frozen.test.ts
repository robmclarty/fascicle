import { describe, expect, it } from 'vitest'
import { MODEL_FAMILIES } from '../aliases.js'
import { DEFAULT_PRICING } from '../pricing.js'

describe('frozen defaults', () => {
  it('throws when mutating MODEL_FAMILIES', () => {
    expect(() => {
      (MODEL_FAMILIES as Record<string, unknown>)['injected'] = { anthropic: 'x' }
    }).toThrow()
  })

  it('throws when mutating a MODEL_FAMILIES entry', () => {
    expect(() => {
      (MODEL_FAMILIES['opus'] as Record<string, string>)['anthropic'] = 'tampered'
    }).toThrow()
  })

  it('throws when mutating DEFAULT_PRICING', () => {
    expect(() => {
      (DEFAULT_PRICING as Record<string, unknown>)['injected'] = {
        input_per_million: 0,
        output_per_million: 0,
      }
    }).toThrow()
  })
})
