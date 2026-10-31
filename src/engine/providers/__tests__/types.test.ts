import { describe, expect, it } from 'vitest'
import { engine_config_error } from '../../errors.js'
import type { ProviderInit } from '../../types.js'
import {
  default_normalize_usage,
  load_optional_peer,
  missing_config_error,
  missing_peer_error,
  refuse_credentials_in_base_url,
} from '../types.js'

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

describe('missing_config_error', () => {
  it('names the key to pass and where its value usually comes from, tagged with the provider', () => {
    const err = missing_config_error('acme', 'api_key', 'process.env.ACME_API_KEY')
    expect(err).toBeInstanceOf(engine_config_error)
    expect(err.message).toBe(
      'acme provider requires a non-empty api_key: pass providers.acme.api_key to create_engine, usually process.env.ACME_API_KEY',
    )
    expect(err.provider).toBe('acme')
  })
})

describe('refuse_credentials_in_base_url', () => {
  const refused = (provider: string, base_url: unknown): unknown => {
    // Set through Reflect, since a base_url that isn't a string is what some cases check.
    const init: ProviderInit = {}
    Reflect.set(init, 'base_url', base_url)
    try {
      refuse_credentials_in_base_url(provider, init)
    } catch (err: unknown) {
      return err
    }
    return undefined
  }

  it('refuses a user name or password before the host, with a scheme or without one, never repeating it', () => {
    for (const base_url of [
      'http://user:sk-secret@gateway.example/v1',
      'https://user@gateway.example',
      'user:sk-secret@localhost:11434',
      'a@localhost:11434',
      'http://user@',
    ]) {
      const err = refused('openai', base_url)
      expect(err, base_url).toBeInstanceOf(engine_config_error)
      expect((err as engine_config_error).provider, base_url).toBe('openai')
      expect((err as Error).message, base_url).toBe(
        "openai provider's base_url holds a user name or password, which fetch refuses to send: take them out of base_url, and pass the key as providers.openai.api_key",
      )
    }
  })

  it('says that a local provider sends no credentials at all', () => {
    for (const provider of ['ollama', 'lmstudio']) {
      expect((refused(provider, 'http://me:pw@localhost:11434') as Error).message, provider).toBe(
        `${provider} provider's base_url holds a user name or password, which fetch refuses to send: take them out of base_url, since the ${provider} provider sends no credentials`,
      )
    }
  })

  it('passes an @ in a path, a query, or a fragment, and a base_url without one', () => {
    for (const base_url of [
      'https://gateway.example/v1/@scope',
      'https://gateway.example/v1?user=a@b',
      'https://gateway.example/#a@b',
      'http://localhost:11434',
      'localhost:11434',
      '',
    ]) {
      expect(refused('openai', base_url), base_url).toBeUndefined()
    }
  })

  it('passes a base_url that is absent or not a string', () => {
    for (const base_url of [undefined, 42, null]) {
      expect(refused('openai', base_url)).toBeUndefined()
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
