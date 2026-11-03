/**
 * Claude Code sandbox settings tests.
 *
 * Pins the `--settings` JSON that a `claude_code` sandbox renders, key by
 * key, and the two checks that refuse a policy the CLI would read wrong:
 * relative paths at construction, and a second `--settings` in a call.
 */

import { describe, expect, it } from 'vitest'
import { engine_config_error } from '../../../errors.js'
import {
  render_sandbox_settings,
  validate_sandbox_config,
  validate_sandbox_extra_args,
} from '../../../providers/claude_cli/settings.js'

describe('render_sandbox_settings', () => {
  it('renders a fail-closed sandbox with no network and no extra paths by default', () => {
    expect(JSON.parse(render_sandbox_settings({ kind: 'claude_code' }))).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: false,
        network: { allowedDomains: [], strictAllowlist: true },
        filesystem: { allowWrite: [], allowRead: [], denyRead: [] },
      },
      permissions: {
        blockReadsOutsideWorkingDirectories: true,
        blockWritesOutsideWorkingDirectories: true,
        deny: [],
      },
      disableAllHooks: true,
    })
  })

  it('maps each policy list onto its sandbox key, and the denied paths onto Read rules', () => {
    const settings = JSON.parse(
      render_sandbox_settings({
        kind: 'claude_code',
        network_allowlist: ['openrouter.ai', '*.github.com'],
        additional_write_paths: ['/tmp/build', '~/.cache/pnpm'],
        additional_read_paths: ['~/.npmrc'],
        deny_read_paths: ['~/.ssh', '/etc/secrets'],
      }),
    ) as {
      sandbox: { network: unknown; filesystem: unknown }
      permissions: { deny: unknown }
    }
    expect(settings.sandbox.network).toEqual({
      allowedDomains: ['openrouter.ai', '*.github.com'],
      strictAllowlist: true,
    })
    expect(settings.sandbox.filesystem).toEqual({
      allowWrite: ['/tmp/build', '~/.cache/pnpm'],
      allowRead: ['~/.npmrc'],
      denyRead: ['~/.ssh', '/etc/secrets'],
    })
    // Permission rules spell an absolute path with `//`; the sandbox lists don't.
    expect(settings.permissions.deny).toEqual([
      'Read(~/.ssh)',
      'Read(~/.ssh/**)',
      'Read(//etc/secrets)',
      'Read(//etc/secrets/**)',
    ])
  })

  it('drops trailing slashes so a directory renders the same rules either way', () => {
    const settings = JSON.parse(
      render_sandbox_settings({
        kind: 'claude_code',
        additional_write_paths: ['/tmp/out/'],
        additional_read_paths: ['~/.config/npm//'],
        deny_read_paths: ['~/.aws/'],
      }),
    ) as { sandbox: { filesystem: unknown }; permissions: { deny: unknown } }
    expect(settings.sandbox.filesystem).toEqual({
      allowWrite: ['/tmp/out'],
      allowRead: ['~/.config/npm'],
      denyRead: ['~/.aws'],
    })
    expect(settings.permissions.deny).toEqual(['Read(~/.aws)', 'Read(~/.aws/**)'])
  })

  it('keeps a path no longer than its prefix as written', () => {
    const settings = JSON.parse(
      render_sandbox_settings({ kind: 'claude_code', deny_read_paths: ['~/', '/'] }),
    ) as { sandbox: { filesystem: { denyRead: unknown } } }
    expect(settings.sandbox.filesystem.denyRead).toEqual(['~/', '/'])
  })

  it('renders compact JSON, one argv element with no newlines', () => {
    expect(render_sandbox_settings({ kind: 'claude_code' })).not.toContain('\n')
  })
})

describe('validate_sandbox_config', () => {
  it('accepts absolute and home-relative paths in every list', () => {
    expect(() =>
      validate_sandbox_config({
        sandbox: {
          kind: 'claude_code',
          additional_write_paths: ['/tmp/a'],
          additional_read_paths: ['~/.npmrc'],
          deny_read_paths: ['~/.ssh'],
        },
      }),
    ).not.toThrow()
  })

  for (const list of ['additional_write_paths', 'additional_read_paths', 'deny_read_paths'] as const) {
    it(`refuses a relative path in ${list}, naming it`, () => {
      const run = (): void =>
        validate_sandbox_config({ sandbox: { kind: 'claude_code', [list]: ['/ok', 'out/dir'] } })
      expect(run).toThrow(engine_config_error)
      expect(run).toThrow(
        'providers.claude_cli.sandbox has relative paths (out/dir): make each one absolute or start it with ~/',
      )
    })
  }

  it('reads ./ and a bare ~ as relative', () => {
    expect(() =>
      validate_sandbox_config({ sandbox: { kind: 'claude_code', deny_read_paths: ['./secrets', '~'] } }),
    ).toThrow('(./secrets, ~)')
  })

  it('names claude_cli as the provider', () => {
    try {
      validate_sandbox_config({ sandbox: { kind: 'claude_code', deny_read_paths: ['x'] } })
      expect.unreachable('validate_sandbox_config should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(engine_config_error)
      expect((err as engine_config_error).provider).toBe('claude_cli')
    }
  })

  it('leaves the wrapper kinds and an unsandboxed config alone', () => {
    expect(() => validate_sandbox_config({})).not.toThrow()
    expect(() =>
      validate_sandbox_config({ sandbox: { kind: 'bwrap', additional_write_paths: ['rel'] } }),
    ).not.toThrow()
  })
})

describe('validate_sandbox_extra_args', () => {
  const sandbox = { kind: 'claude_code' } as const

  it('refuses --settings as its own argument or with its value attached', () => {
    for (const extra_args of [['--settings', '{}'], ['--settings={}']]) {
      const run = (): void => validate_sandbox_extra_args(sandbox, extra_args)
      expect(run).toThrow(engine_config_error)
      expect(run).toThrow("extra_args can't carry --settings under a claude_code sandbox")
    }
  })

  it('names claude_cli as the provider', () => {
    try {
      validate_sandbox_extra_args(sandbox, ['--settings', '{}'])
      expect.unreachable('validate_sandbox_extra_args should have thrown')
    } catch (err) {
      expect((err as engine_config_error).provider).toBe('claude_cli')
    }
  })

  it('lets other flags through, --setting-sources included', () => {
    expect(() =>
      validate_sandbox_extra_args(sandbox, ['--setting-sources', 'user', '--max-turns', '3']),
    ).not.toThrow()
    expect(() => validate_sandbox_extra_args(sandbox, undefined)).not.toThrow()
  })

  it('leaves --settings alone without a claude_code sandbox', () => {
    expect(() => validate_sandbox_extra_args(undefined, ['--settings', '{}'])).not.toThrow()
    expect(() =>
      validate_sandbox_extra_args({ kind: 'greywall' }, ['--settings', '{}']),
    ).not.toThrow()
  })
})
