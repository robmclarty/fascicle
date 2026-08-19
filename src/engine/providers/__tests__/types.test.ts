import { describe, expect, it } from 'vitest'
import { default_normalize_usage, load_optional_peer, missing_peer_error } from '../types.js'

describe('default_normalize_usage', () => {
  it('returns zero-only usage when raw is undefined', () => {
    expect(default_normalize_usage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    })
  })

  it('prefers flat fields over nested *_token_details', () => {
    const totals = default_normalize_usage({
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 40,
      cache_write_tokens: 10,
      reasoning_tokens: 5,
      input_token_details: { cached_tokens: 999, cache_creation_input_tokens: 999 },
      output_token_details: { reasoning_tokens: 999 },
    })
    expect(totals).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 40,
      cache_write_tokens: 10,
      reasoning_tokens: 5,
    })
  })

  it('falls back to nested *_token_details fields', () => {
    const totals = default_normalize_usage({
      input_tokens: 100,
      output_tokens: 20,
      input_token_details: { cached_tokens: 60, cache_creation_input_tokens: 15 },
      output_token_details: { reasoning_tokens: 8 },
    })
    expect(totals.cached_input_tokens).toBe(60)
    expect(totals.cache_write_tokens).toBe(15)
    expect(totals.reasoning_tokens).toBe(8)
  })
})

describe('load_optional_peer', () => {
  it('wraps a missing-module failure in an Error naming the specifier', async () => {
    try {
      await load_optional_peer('@repo/definitely-not-a-real-package')
      expect.unreachable('expected missing-peer error')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      const message = (err as Error).message
      expect(message).toContain('@repo/definitely-not-a-real-package')
      expect(message).toContain('missing peer dependency')
    }
  })
})

describe('missing_peer_error', () => {
  it('names the peer and a package-manager-neutral install hint', () => {
    const cause = new Error('Cannot find module')
    const err = missing_peer_error('ai', cause)
    expect(err.message).toBe(
      "missing peer dependency 'ai'. Install it with your package manager, e.g., `pnpm add ai` or `npm install ai`. Cause: Cannot find module",
    )
    expect(err.cause).toBe(cause)
  })

  it('stringifies a non-Error cause into the message', () => {
    const err = missing_peer_error('ai', { code: 'ERR_MODULE_NOT_FOUND' })
    expect(err.message).toBe(
      'missing peer dependency \'ai\'. Install it with your package manager, e.g., `pnpm add ai` or `npm install ai`. Cause: {"code":"ERR_MODULE_NOT_FOUND"}',
    )
  })
})
