import { describe, expect, it } from 'vitest'

import { app_engine_config, read_engine_env } from '../engine.js'
import { parse_argv } from '../main.js'

const FIXTURE_ARGV = ['node', 'main.ts', '--fixture', 'fixtures/pr-sample.patch']

describe('pr-improve provider selection', () => {
  it('builds an OpenRouter engine on the native transport from OPENROUTER_API_KEY when nothing names a provider', () => {
    const args = parse_argv(FIXTURE_ARGV)
    expect('provider' in args).toBe(false)
    const cfg = read_engine_env({ OPENROUTER_API_KEY: 'sk-or-test' }, args.provider)
    expect(cfg.provider).toBe('openrouter')
    expect(app_engine_config(cfg)).toStrictEqual({
      providers: { openrouter: { api_key: 'sk-or-test', transport: 'native' } },
    })
  })

  it('names the missing key when the default provider has none', () => {
    expect(() => read_engine_env({})).toThrow('OPENROUTER_API_KEY is required for the openrouter provider')
  })

  it('runs claude_cli under --provider claude_cli, with no key', () => {
    const cfg = read_engine_env({}, parse_argv([...FIXTURE_ARGV, '--provider', 'claude_cli']).provider)
    expect(cfg.provider).toBe('claude_cli')
    expect(Object.keys(app_engine_config(cfg).providers)).toEqual(['claude_cli'])
  })

  it('refuses FASCICLE_PROVIDER=claude_cli and points at the flag', () => {
    expect(() => read_engine_env({ FASCICLE_PROVIDER: 'claude_cli', OPENROUTER_API_KEY: 'k' })).toThrow(
      'pass --provider claude_cli',
    )
  })

  it('lets FASCICLE_PROVIDER pick anthropic, and lets --provider win over it', () => {
    expect(read_engine_env({ FASCICLE_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' }).provider).toBe('anthropic')
    expect(read_engine_env({ FASCICLE_PROVIDER: 'anthropic', OPENROUTER_API_KEY: 'o' }, 'openrouter').provider).toBe(
      'openrouter',
    )
  })
})
