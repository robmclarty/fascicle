/**
 * Test oracle: shell out to vitest against the toy package and return a
 * structured verdict. The verdict is the only signal each phase trusts.
 *
 * Exposed as a port (`TestOracle`) so the flow takes the oracle as data. The
 * real implementation spawns vitest; a flow test injects a scripted one and
 * exercises the topology without running a test suite inside a test suite.
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { TestVerdict } from '../types.js'

export type TestOracle = (signal?: AbortSignal) => Promise<TestVerdict>

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..', '..')
const VITEST_CONFIG = join(PACKAGE_ROOT, 'vitest.config.ts')

export const TOY_SRC = join(PACKAGE_ROOT, 'toy', 'src')

const TAIL_BYTES = 2_000

function tail(buf: string): string {
  return buf.length <= TAIL_BYTES ? buf : `…\n${buf.slice(buf.length - TAIL_BYTES)}`
}

export async function run_vitest(signal?: AbortSignal): Promise<TestVerdict> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'pnpm',
      ['exec', 'vitest', 'run', '--config', VITEST_CONFIG, '--reporter=default'],
      {
        cwd: PACKAGE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal,
      },
    )

    let out = ''
    proc.stdout.on('data', (b: Buffer) => {
      out += b.toString()
    })
    proc.stderr.on('data', (b: Buffer) => {
      out += b.toString()
    })
    proc.on('error', (err) => {
      reject(err)
    })
    proc.on('close', (code) => {
      const exit_code = code ?? -1
      resolve({ passed: exit_code === 0, exit_code, tail: tail(out) })
    })
  })
}
