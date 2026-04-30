import { describe, expect, it } from 'vitest'
import { merge_provider_options } from '../merge_defaults.js'

describe('merge_provider_options', () => {
  it('returns undefined when both sides are undefined', () => {
    expect(merge_provider_options(undefined, undefined)).toBeUndefined()
  })

  it('returns the call-side when defaults are undefined', () => {
    const call = { claude_cli: { plugin_dirs: ['x'] } }
    expect(merge_provider_options(undefined, call)).toBe(call)
  })

  it('clones defaults when call-side is undefined', () => {
    const defaults = { claude_cli: { env: { PATH: '/bin' } } } as const
    const out = merge_provider_options(defaults, undefined)
    expect(out).toEqual({ claude_cli: { env: { PATH: '/bin' } } })
    expect(out).not.toBe(defaults)
  })

  it('merges inner keys per provider: per-call wins for same key', () => {
    const defaults = {
      claude_cli: { env: { PATH: '/usr/bin' }, setting_sources: ['user'] },
    } as const
    const call = { claude_cli: { plugin_dirs: ['./p'] } }
    const out = merge_provider_options(defaults, call) as Record<
      string,
      Record<string, unknown>
    >
    expect(out['claude_cli']).toEqual({
      env: { PATH: '/usr/bin' },
      setting_sources: ['user'],
      plugin_dirs: ['./p'],
    })
  })

  it('per-call replaces same inner key wholesale (no recursion)', () => {
    const defaults = {
      claude_cli: { env: { PATH: '/usr/bin', HOME: '/h' } },
    } as const
    const call = { claude_cli: { env: { PATH: '/other' } } }
    const out = merge_provider_options(defaults, call) as Record<
      string,
      Record<string, unknown>
    >
    expect(out['claude_cli']).toEqual({ env: { PATH: '/other' } })
  })

  it('provider keys unique to one side fall through', () => {
    const defaults = { claude_cli: { env: { X: '1' } } } as const
    const call = { anthropic: { cache_control: 'ephemeral' } }
    const out = merge_provider_options(defaults, call) as Record<string, unknown>
    expect(out['claude_cli']).toEqual({ env: { X: '1' } })
    expect(out['anthropic']).toEqual({ cache_control: 'ephemeral' })
  })
})
