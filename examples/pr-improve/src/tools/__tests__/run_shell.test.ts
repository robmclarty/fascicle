import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { make_ctx, type ToolExecContextStub } from './_helpers.js'
import { make_run_shell, RunShellAllowlistError, type RunShellOutput } from '../run_shell.js'

let root: string
let ctx: ToolExecContextStub

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pr-improve-run-shell-'))
  ctx = make_ctx()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('run_shell allowlist', () => {
  it('rejects commands not in the allowlist', async () => {
    const tool = make_run_shell(root)
    await expect(tool.execute({ argv: ['rm', '-rf', '/'] }, ctx)).rejects.toThrow(
      RunShellAllowlistError,
    )
    await expect(tool.execute({ argv: ['curl', 'https://evil'] }, ctx)).rejects.toThrow(
      /command not allowed/,
    )
  })

  it('rejects git subcommands not in the allowlist', async () => {
    const tool = make_run_shell(root)
    await expect(tool.execute({ argv: ['git', 'push'] }, ctx)).rejects.toThrow(
      /git subcommand not allowed/,
    )
    await expect(tool.execute({ argv: ['git', 'reset', '--hard'] }, ctx)).rejects.toThrow(
      /git subcommand not allowed/,
    )
  })

  it('rejects empty argv', async () => {
    const tool = make_run_shell(root)
    const parse = tool.input_schema.safeParse({ argv: [] })
    expect(parse.success).toBe(false)
  })

  it('rejects empty-string entries inside argv via schema', () => {
    const tool = make_run_shell(root)
    const parse = tool.input_schema.safeParse({ argv: ['git', ''] })
    expect(parse.success).toBe(false)
  })

  it('rejects git with no subcommand', async () => {
    const tool = make_run_shell(root)
    await expect(tool.execute({ argv: ['git'] }, ctx)).rejects.toThrow(/subcommand/)
  })
})

describe('run_shell execution', () => {
  it('runs an allowed git status in a fresh worktree and reports a non-zero code', async () => {
    // Not a git repo, so `git status` exits non-zero. We only assert the
    // tool ran, captured stderr, and returned a code (no allowlist throw).
    const tool = make_run_shell(root)
    const out = (await tool.execute({ argv: ['git', 'status'] }, ctx)) as RunShellOutput
    expect(typeof out.code).toBe('number')
    expect(out.code).not.toBe(0)
    expect(out.stderr.length).toBeGreaterThan(0)
    expect(out.timed_out).toBe(false)
  })

  it('runs `pnpm --version` and captures stdout', async () => {
    const tool = make_run_shell(root)
    const out = (await tool.execute({ argv: ['pnpm', '--version'] }, ctx)) as RunShellOutput
    expect(out.code).toBe(0)
    expect(out.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
    expect(out.truncated).toBe(false)
  })

  it('honors caller abort signal by aborting the child process', async () => {
    const ctrl = new AbortController()
    const test_ctx = { ...make_ctx(), abort: ctrl.signal }
    const tool = make_run_shell(root)
    // Start a long pnpm subcommand likely to exceed instant completion.
    // We abort almost immediately to verify the signal wires through.
    const promise = tool.execute({ argv: ['pnpm', 'help', 'install'] }, test_ctx)
    setTimeout(() => ctrl.abort(new Error('test abort')), 10)
    await expect(promise).rejects.toBeDefined()
  })
})
