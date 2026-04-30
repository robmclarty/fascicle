import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  get_anthropic_api_key,
  get_anthropic_base_url,
  get_google_api_key,
  get_lmstudio_base_url,
  get_node_env,
  get_ollama_base_url,
  get_openai_api_key,
  get_openai_organization,
  get_openrouter_api_key,
  get_openrouter_http_referer,
  reset_config_for_tests,
} from '../index.js'

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

describe('accessor functions', () => {
  it('return undefined when the corresponding env var is absent', () => {
    expect(get_anthropic_api_key()).toBeUndefined()
    expect(get_anthropic_base_url()).toBeUndefined()
    expect(get_openai_api_key()).toBeUndefined()
    expect(get_openai_organization()).toBeUndefined()
    expect(get_google_api_key()).toBeUndefined()
    expect(get_ollama_base_url()).toBeUndefined()
    expect(get_lmstudio_base_url()).toBeUndefined()
    expect(get_openrouter_api_key()).toBeUndefined()
    expect(get_openrouter_http_referer()).toBeUndefined()
  })

  it('return the string values when the env vars are set', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant'
    process.env['OPENAI_API_KEY'] = 'sk-oai'
    process.env['OPENROUTER_HTTP_REFERER'] = 'https://example.test'
    expect(get_anthropic_api_key()).toBe('sk-ant')
    expect(get_openai_api_key()).toBe('sk-oai')
    expect(get_openrouter_http_referer()).toBe('https://example.test')
  })

  it('get_node_env defaults to development', () => {
    expect(get_node_env()).toBe('development')
  })
})
