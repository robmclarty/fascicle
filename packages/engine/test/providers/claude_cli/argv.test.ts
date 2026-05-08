/**
 * Argv construction tests (spec §6.1, §12 #2, #10, #11, #30).
 *
 * These tests are pure and exercise build_cli_argv / merge_allowed_tools /
 * merge_system / build_sandbox_plan. They also run the argv-injection audit
 * (constraints §9): no option value must be constructed via template-literal
 * interpolation.
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  build_cli_argv,
  merge_allowed_tools,
  merge_system,
} from '../../../src/providers/claude_cli/argv.js'
import { build_sandbox_plan } from '../../../src/providers/claude_cli/sandbox.js'
import { DEFAULT_SETTING_SOURCES } from '../../../src/providers/claude_cli/constants.js'

const here = dirname(fileURLToPath(import.meta.url))

const minimal_input = {
  model_id: 'claude-sonnet-4-6',
  provider_config: {},
  call_opts: {},
  merged_allowed_tools: [] as ReadonlyArray<string>,
  merged_system: '',
}

function find_flag_value(argv: ReadonlyArray<string>, flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx === -1) return undefined
  return argv[idx + 1]
}

function find_all_flag_values(argv: ReadonlyArray<string>, flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag) {
      const v = argv[i + 1]
      if (v !== undefined) out.push(v)
    }
  }
  return out
}

describe('build_cli_argv — mandatory structure', () => {
  it('§12 #1 — includes -p, --output-format stream-json, --model, --verbose, --setting-sources', () => {
    const argv = build_cli_argv(minimal_input)
    expect(argv[0]).toBe('-p')
    expect(find_flag_value(argv, '--output-format')).toBe('stream-json')
    expect(find_flag_value(argv, '--model')).toBe('claude-sonnet-4-6')
    expect(argv).toContain('--verbose')
    expect(find_flag_value(argv, '--setting-sources')).toBe(
      [...DEFAULT_SETTING_SOURCES].join(','),
    )
  })

  it('every option value travels as its own argv element (not --flag=value)', () => {
    const argv = build_cli_argv({
      ...minimal_input,
      call_opts: {
        session_id: 'abc',
        agents: { planner: { description: 'plan', prompt: 'plan' } },
        extra_args: ['--foo', 'bar'],
      },
      merged_allowed_tools: ['Read'],
      merged_system: 'system-prose',
      compiled_schema: '{"type":"object"}',
    })
    for (const entry of argv) {
      expect(entry.startsWith('--') && entry.includes('=')).toBe(false)
    }
  })
})

describe('build_cli_argv — conditional flags', () => {
  it('§12 #2 — adds --resume when session_id is non-empty', () => {
    const argv = build_cli_argv({
      ...minimal_input,
      call_opts: { session_id: 'sess-xyz' },
    })
    expect(find_flag_value(argv, '--resume')).toBe('sess-xyz')
  })

  it('omits --resume when session_id is missing or empty', () => {
    const a = build_cli_argv(minimal_input)
    expect(a).not.toContain('--resume')
    const b = build_cli_argv({ ...minimal_input, call_opts: { session_id: '' } })
    expect(b).not.toContain('--resume')
  })

  it('§12 #10 — adds --agents with serialized JSON when provided', () => {
    const agents = {
      planner: { description: 'plan', prompt: 'plan a step' },
      runner: { description: 'run', prompt: 'run it', model: 'claude-opus' },
    }
    const argv = build_cli_argv({
      ...minimal_input,
      call_opts: { agents },
    })
    expect(find_flag_value(argv, '--agents')).toBe(JSON.stringify(agents))
  })

  it('§12 #11 — emits one --plugin-dir flag per configured directory', () => {
    const argv = build_cli_argv({
      ...minimal_input,
      provider_config: { plugin_dirs: ['/a', '/b', '/c'] },
    })
    const values = find_all_flag_values(argv, '--plugin-dir')
    expect(values).toEqual(['/a', '/b', '/c'])
  })

  it('§12 #6 — adds --json-schema with compiled schema when supplied', () => {
    const argv = build_cli_argv({
      ...minimal_input,
      compiled_schema: '{"type":"string"}',
    })
    expect(find_flag_value(argv, '--json-schema')).toBe('{"type":"string"}')
  })

  it('omits --json-schema when compiled_schema is empty string', () => {
    const argv = build_cli_argv({ ...minimal_input, compiled_schema: '' })
    expect(argv).not.toContain('--json-schema')
  })

  it('adds --append-system-prompt when merged_system is non-empty', () => {
    const argv = build_cli_argv({ ...minimal_input, merged_system: 'rules' })
    expect(find_flag_value(argv, '--append-system-prompt')).toBe('rules')
  })

  it('omits --append-system-prompt when merged_system is empty', () => {
    const argv = build_cli_argv(minimal_input)
    expect(argv).not.toContain('--append-system-prompt')
  })

  it('emits one --allowedTools flag per tool (grammar passes through verbatim)', () => {
    const argv = build_cli_argv({
      ...minimal_input,
      merged_allowed_tools: ['Read', 'Edit', 'Bash(git:*)', 'Write(/tmp/**)'],
    })
    const vals = find_all_flag_values(argv, '--allowedTools')
    expect(vals).toEqual(['Read', 'Edit', 'Bash(git:*)', 'Write(/tmp/**)'])
  })

  it('§12 #30 — extra_args are appended verbatim', () => {
    const argv = build_cli_argv({
      ...minimal_input,
      call_opts: { extra_args: ['--foo', 'bar', '--baz'] },
    })
    const tail = argv.slice(-3)
    expect(tail).toEqual(['--foo', 'bar', '--baz'])
  })

  it('custom setting_sources override DEFAULT_SETTING_SOURCES', () => {
    const argv = build_cli_argv({
      ...minimal_input,
      provider_config: { setting_sources: ['user'] },
    })
    expect(find_flag_value(argv, '--setting-sources')).toBe('user')
  })

  it('returned argv is frozen', () => {
    const argv = build_cli_argv(minimal_input)
    expect(Object.isFrozen(argv)).toBe(true)
  })
})

describe('merge_system', () => {
  it('joins opts.system and append_system_prompt with a blank line', () => {
    expect(merge_system('a', 'b')).toBe('a\n\nb')
  })

  it('returns only opts.system when append is undefined', () => {
    expect(merge_system('a', undefined)).toBe('a')
  })

  it('returns only append when opts.system is undefined', () => {
    expect(merge_system(undefined, 'b')).toBe('b')
  })

  it('returns empty string when both are empty', () => {
    expect(merge_system(undefined, undefined)).toBe('')
    expect(merge_system('', '')).toBe('')
  })
})

describe('merge_allowed_tools', () => {
  it('deduplicates while preserving first-seen order', () => {
    const merged = merge_allowed_tools(['Read', 'Edit'], ['Edit', 'Bash'])
    expect(merged).toEqual(['Read', 'Edit', 'Bash'])
  })

  it('handles undefined call_allowlist', () => {
    expect(merge_allowed_tools(undefined, ['Read'])).toEqual(['Read'])
  })

  it('returns [] for no inputs', () => {
    expect(merge_allowed_tools(undefined, [])).toEqual([])
  })
})

describe('build_sandbox_plan', () => {
  it('no sandbox: spawn_cmd is the binary, prefix_args is empty', () => {
    const plan = build_sandbox_plan('claude', undefined)
    expect(plan.spawn_cmd).toBe('claude')
    expect(plan.prefix_args).toEqual([])
  })

  it('§12 #12 — bwrap plan: spawn_cmd is bwrap; binary appears after sandbox args', () => {
    const plan = build_sandbox_plan('claude', { kind: 'bwrap' })
    expect(plan.spawn_cmd).toBe('bwrap')
    const idx = plan.prefix_args.indexOf('claude')
    expect(idx).toBeGreaterThan(0)
    expect(plan.prefix_args[idx - 1]).toBe('--')
  })

  it('bwrap network_allowlist injects --share-net plus per-host setenv entries', () => {
    const plan = build_sandbox_plan('claude', {
      kind: 'bwrap',
      network_allowlist: ['api.anthropic.com', 'example.com'],
    })
    expect(plan.prefix_args).toContain('--share-net')
    const values: string[] = []
    for (let i = 0; i < plan.prefix_args.length; i += 1) {
      if (plan.prefix_args[i] === '--setenv' && plan.prefix_args[i + 1] === 'CLAUDE_CLI_NET_ALLOW') {
        const v = plan.prefix_args[i + 2]
        if (v !== undefined) values.push(v)
      }
    }
    expect(values).toEqual(['api.anthropic.com', 'example.com'])
  })

  it('bwrap additional_write_paths emit --bind entries', () => {
    const plan = build_sandbox_plan('claude', {
      kind: 'bwrap',
      additional_write_paths: ['/tmp/out'],
    })
    const idx = plan.prefix_args.indexOf('--bind')
    expect(idx).toBeGreaterThan(-1)
    expect(plan.prefix_args[idx + 1]).toBe('/tmp/out')
    expect(plan.prefix_args[idx + 2]).toBe('/tmp/out')
  })

  it('greywall plan: spawn_cmd is greywall; writes settings JSON with hosts/paths', () => {
    const plan = build_sandbox_plan('claude', {
      kind: 'greywall',
      network_allowlist: ['h.example', 'api.anthropic.com'],
      additional_write_paths: ['/w', '/tmp/out'],
    })
    expect(plan.spawn_cmd).toBe('greywall')
    expect(plan.prefix_args[0]).toBe('--settings')
    const settings_path = plan.prefix_args[1]
    expect(typeof settings_path).toBe('string')
    expect(plan.prefix_args[2]).toBe('--')
    expect(plan.prefix_args[3]).toBe('claude')

    if (typeof settings_path !== 'string') throw new Error('unreachable')
    const payload = JSON.parse(readFileSync(settings_path, 'utf8')) as {
      network: { allowHosts: string[] }
      filesystem: { allowWrite: string[] }
    }
    expect(payload.network.allowHosts).toEqual(['h.example', 'api.anthropic.com'])
    expect(payload.filesystem.allowWrite).toEqual(['/w', '/tmp/out'])
  })

  it('greywall plan with caller-supplied settings_path skips temp-file generation', () => {
    const plan = build_sandbox_plan('claude', {
      kind: 'greywall',
      settings_path: '/etc/greywall/custom.json',
    })
    expect(plan.spawn_cmd).toBe('greywall')
    expect(plan.prefix_args).toEqual(['--settings', '/etc/greywall/custom.json', '--', 'claude'])
  })
})

describe('argv-injection audit (architectural validation #16)', () => {
  it('argv.ts contains no template-literal option construction of --flag=${value}', async () => {
    const source = await readFile(
      join(here, '../../../src/providers/claude_cli/argv.ts'),
      'utf8',
    )
    expect(source).not.toMatch(/`\s*--[a-z][\w-]*=\$\{/i)
    expect(source).not.toMatch(/['"]--[a-z][\w-]*=['"]\s*\+/i)
  })

  it('no file under claude_cli/ constructs --<flag>=<value> via template literal', async () => {
    const files = [
      'argv.ts',
      'auth.ts',
      'constants.ts',
      'cost.ts',
      'index.ts',
      'sandbox.ts',
      'spawn.ts',
      'stream_parse.ts',
      'stream_result.ts',
      'types.ts',
    ]
    for (const name of files) {
      const src = await readFile(
        join(here, '../../../src/providers/claude_cli/', name),
        'utf8',
      )
      expect(src, `forbidden pattern in ${name}`).not.toMatch(/`\s*--[a-z][\w-]*=\$\{/i)
    }
  })
})
