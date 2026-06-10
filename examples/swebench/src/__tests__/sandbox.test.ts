import { stat } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { noop_sandbox } from '../sandbox.js'
import type { SweBenchInstance } from '../types.js'

const INSTANCE: SweBenchInstance = {
  instance_id: 'example__example-0000',
  repo: 'example/example',
  base_commit: 'deadbeef',
  problem_statement: 'placeholder',
  hints_text: '',
  test_patch: '',
  version: '1.0',
  fail_to_pass: [],
  pass_to_pass: [],
}

describe('noop_sandbox', () => {
  it('returns a workdir that exists on disk', async () => {
    const sandbox = await noop_sandbox(INSTANCE, new AbortController().signal)
    const info = await stat(sandbox.workdir)
    expect(info.isDirectory()).toBe(true)
    await sandbox.dispose()
  })

  it('dispose removes the workdir', async () => {
    const sandbox = await noop_sandbox(INSTANCE, new AbortController().signal)
    await sandbox.dispose()
    await expect(stat(sandbox.workdir)).rejects.toThrow()
  })
})
