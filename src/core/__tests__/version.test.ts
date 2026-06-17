import { describe, expect, it } from 'vitest'
import { version } from '../version.js'

describe('version', () => {
  it('is a non-empty string', () => {
    expect(typeof version).toBe('string')
    expect(version.length).toBeGreaterThan(0)
  })
})
