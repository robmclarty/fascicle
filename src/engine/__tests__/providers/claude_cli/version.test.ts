/**
 * Claude Code version gate tests.
 *
 * Covers reading the version that `claude --version` prints, comparing it
 * against the sandbox's floor, and the gate itself over a fake spawn
 * runtime. The gate is also covered through the adapter in
 * adapter_generate.test.ts and against the mock binary in
 * claude_code_sandbox.test.ts.
 */

import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { claude_cli_error } from '../../../errors.js'
import { CLAUDE_CODE_SANDBOX_MIN_VERSION } from '../../../providers/claude_cli/constants.js'
import type { SpawnArgs, SpawnRuntime } from '../../../providers/claude_cli/spawn.js'
import {
  create_cli_version_gate,
  parse_cli_version,
  version_at_least,
} from '../../../providers/claude_cli/version.js'

type Reply = { readonly lines: ReadonlyArray<string>; readonly code: number | null; readonly stderr?: string }

/** A spawn runtime that answers each spawn with the next reply and records its args. */
function fake_runtime(replies: ReadonlyArray<Reply>): { runtime: SpawnRuntime; calls: SpawnArgs[] } {
  const calls: SpawnArgs[] = []
  const runtime: SpawnRuntime = {
    live_children: new Set(),
    spawn_cli: async (args) => {
      const reply = replies[calls.length] ?? { lines: [], code: 0 }
      calls.push(args)
      return {
        child: {} as unknown as ChildProcess,
        stdout_lines: (async function* () {
          yield* reply.lines
        })(),
        wait_close: async () => ({ code: reply.code, signal: null, stderr: reply.stderr ?? '' }),
        request_terminate: () => {},
      }
    },
    dispose_all: async () => {},
  }
  return { runtime, calls }
}

const INIT = { cmd: '/opt/claude', startup_timeout_ms: 1000, stall_timeout_ms: 2000 }
const ENV = { PATH: '/bin' }

/** Run one gate check and return what it threw. */
async function gate_error(reply: Reply): Promise<claude_cli_error> {
  const { runtime } = fake_runtime([reply])
  const err = await create_cli_version_gate(runtime, INIT)
    .ensure(ENV, new AbortController().signal)
    .catch((e: unknown) => e)
  expect(err).toBeInstanceOf(claude_cli_error)
  return err as claude_cli_error
}

describe('parse_cli_version', () => {
  it('reads the version that leads the output', () => {
    expect(parse_cli_version('2.1.316 (Claude Code)')).toEqual([2, 1, 316])
    expect(parse_cli_version('  10.0.7\n')).toEqual([10, 0, 7])
    expect(parse_cli_version('2.10.3')).toEqual([2, 10, 3])
  })

  it('returns undefined for output that does not lead with major.minor.patch', () => {
    expect(parse_cli_version('')).toBeUndefined()
    expect(parse_cli_version('v2.1.316')).toBeUndefined()
    expect(parse_cli_version('2.1 (Claude Code)')).toBeUndefined()
    expect(parse_cli_version('error: unknown option')).toBeUndefined()
  })
})

describe('version_at_least', () => {
  const floor = [2, 1, 314] as const

  it('passes the floor itself and every later release', () => {
    expect(version_at_least([2, 1, 314], floor)).toBe(true)
    expect(version_at_least([2, 1, 315], floor)).toBe(true)
    expect(version_at_least([2, 2, 0], floor)).toBe(true)
    expect(version_at_least([3, 0, 0], floor)).toBe(true)
  })

  it('fails every earlier release, whatever its later parts say', () => {
    expect(version_at_least([2, 1, 313], floor)).toBe(false)
    expect(version_at_least([2, 0, 999], floor)).toBe(false)
    expect(version_at_least([1, 9, 999], floor)).toBe(false)
  })
})

describe('create_cli_version_gate', () => {
  it('runs `<cmd> --version` once with the call env and abort, then remembers the pass', async () => {
    const { runtime, calls } = fake_runtime([{ lines: ['2.1.316 (Claude Code)'], code: 0 }])
    const gate = create_cli_version_gate(runtime, INIT)
    const abort = new AbortController().signal
    await gate.ensure(ENV, abort)
    await gate.ensure(ENV, abort)
    expect(calls).toEqual([
      { ...INIT, argv: ['--version'], env: ENV, stdin: '', abort },
    ])
  })

  it('names the version it found and the floor when the CLI is older', async () => {
    const err = await gate_error({ lines: ['2.1.313 (Claude Code)'], code: 0 })
    expect(err.reason).toBe('sandbox_unavailable')
    expect(err.message).toBe(
      'Claude Code 2.1.313 is older than 2.1.314, the first release that honors every setting the claude_code sandbox needs: run claude update, or point providers.claude_cli.binary at a newer claude',
    )
  })

  it('quotes the trimmed output and the exit code when it reads no version', async () => {
    const err = await gate_error({ lines: ['  oops', 'more  '], code: 0, stderr: 'warn' })
    expect(err.reason).toBe('sandbox_unavailable')
    expect(err.message).toBe(
      "couldn't read a Claude Code version from '/opt/claude --version' (exit 0, output 'oops\nmore'): the claude_code sandbox needs Claude Code 2.1.314 or later, so point providers.claude_cli.binary at a claude that prints one",
    )
    expect(err.stderr_snippet).toBe('warn')
  })

  it('refuses a version that came with a nonzero exit', async () => {
    const err = await gate_error({ lines: ['2.1.316 (Claude Code)'], code: 1 })
    expect(err.message).toContain('(exit 1, output')
  })

  it('cuts long output to 120 characters and stderr to 512', async () => {
    const err = await gate_error({ lines: ['x'.repeat(200)], code: 0, stderr: 'e'.repeat(600) })
    expect(err.message).toContain(`output '${'x'.repeat(120)}'`)
    expect(err.stderr_snippet).toBe('e'.repeat(512))
  })

  it('checks again for a call whose PATH differs, since it can find another binary', async () => {
    const { runtime, calls } = fake_runtime([
      { lines: ['2.1.316 (Claude Code)'], code: 0 },
      { lines: ['2.1.300 (Claude Code)'], code: 0 },
    ])
    const gate = create_cli_version_gate(runtime, INIT)
    const abort = new AbortController().signal
    await gate.ensure({ PATH: '/new/bin' }, abort)
    await gate.ensure({ PATH: '/new/bin' }, abort)
    await expect(gate.ensure({ PATH: '/old/bin' }, abort)).rejects.toMatchObject({
      reason: 'sandbox_unavailable',
    })
    expect(calls.map((c) => c.env['PATH'])).toEqual(['/new/bin', '/old/bin'])
  })

  it('remembers a pass for an env with no PATH as well', async () => {
    const { runtime, calls } = fake_runtime([{ lines: ['2.1.316 (Claude Code)'], code: 0 }])
    const gate = create_cli_version_gate(runtime, INIT)
    const abort = new AbortController().signal
    await gate.ensure({}, abort)
    await gate.ensure({}, abort)
    expect(calls).toHaveLength(1)
  })

  it('checks again after a failure instead of remembering it', async () => {
    const { runtime, calls } = fake_runtime([
      { lines: ['2.1.0 (Claude Code)'], code: 0 },
      { lines: ['2.1.314 (Claude Code)'], code: 0 },
    ])
    const gate = create_cli_version_gate(runtime, INIT)
    const abort = new AbortController().signal
    await expect(gate.ensure(ENV, abort)).rejects.toBeInstanceOf(claude_cli_error)
    await gate.ensure(ENV, abort)
    await gate.ensure(ENV, abort)
    expect(calls).toHaveLength(2)
  })
})

describe('CLAUDE_CODE_SANDBOX_MIN_VERSION', () => {
  it('is 2.1.314, the release that added blockWritesOutsideWorkingDirectories', () => {
    expect(CLAUDE_CODE_SANDBOX_MIN_VERSION).toEqual([2, 1, 314])
    expect(Object.isFrozen(CLAUDE_CODE_SANDBOX_MIN_VERSION)).toBe(true)
  })
})
