import { describe, expect, it } from 'vitest'
import { DEFAULT_PRICING } from '../pricing.js'

describe('frozen defaults', () => {
  it('throws when mutating DEFAULT_PRICING', () => {
    expect(() => {
      (DEFAULT_PRICING as Record<string, unknown>)['injected'] = {
        input_per_million: 0,
        output_per_million: 0,
      }
    }).toThrow()
  })
})
