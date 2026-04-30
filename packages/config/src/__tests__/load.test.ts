import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { load_config, reset_config_for_tests } from '../load.js'

const CONFIG_KEYS = [
  'NODE_ENV',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'GOOGLE_API_KEY',
  'GOOGLE_BASE_URL',
  'OLLAMA_BASE_URL',
  'LMSTUDIO_BASE_URL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_HTTP_REFERER',
  'OPENROUTER_X_TITLE',
]

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const key of CONFIG_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  reset_config_for_tests()
})

afterEach(() => {
  for (const key of CONFIG_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  reset_config_for_tests()
})

describe('load_config', () => {
  it('reads values already present in process.env', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-abc'
    const config = load_config()
    expect(config.ANTHROPIC_API_KEY).toBe('sk-abc')
  })

  it('is idempotent — second call returns the cached value', () => {
    process.env['OPENAI_API_KEY'] = 'sk-one'
    const first = load_config()
    process.env['OPENAI_API_KEY'] = 'sk-two'
    const second = load_config()
    expect(first).toBe(second)
    expect(second.OPENAI_API_KEY).toBe('sk-one')
  })

  it('returns a frozen config object', () => {
    const config = load_config()
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('throws with formatted message when validation fails', () => {
    process.env['NODE_ENV'] = 'staging'
    expect(() => load_config()).toThrow(/invalid environment/)
  })
})
