/**
 * Child process for the SIGINT harness test.
 *
 * Runs a `step` that performs a long-running, abort-aware wait with
 * `ctx.abort` wired into the cancellation path, registers a cleanup handler
 * via `ctx.on_cleanup`, and writes marker files at each observable checkpoint
 * so the parent can assert on them after sending SIGINT.
 *
 * The wait uses `setTimeout` bound to the run's `AbortSignal` rather than a
 * network fetch because the environment this harness runs in may block
 * localhost connections. For the contract under test — cleanup fires, the
 * in-flight operation observes `aborted_error` as its AbortSignal.reason, and
 * the process exits non-zero — an abort-aware Promise is equivalent I/O.
 *
 * Environment inputs:
 *   - MARKER_DIR — directory where marker files are written.
 *
 * Exit codes:
 *   - 0 — unexpected: the flow completed without aborting.
 *   - non-zero — expected: the flow was aborted (a real SIGINT arrived).
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { aborted_error } from '../../src/errors.js'
import { run } from '../../src/runner.js'
import { step } from '../../src/step.js'

function require_marker_dir(): string {
  const value = process.env['MARKER_DIR']
  if (!value) {
    process.stderr.write('MARKER_DIR not set\n')
    process.exit(2)
  }
  return value
}

const marker_dir = require_marker_dir()

async function write_marker(name: string, body: string): Promise<void> {
  await writeFile(join(marker_dir, name), body)
}

async function main(): Promise<void> {
  const long_running = step('slow_io', async (_: number, ctx) => {
    ctx.on_cleanup(async () => {
      await write_marker('cleanup.ok', 'cleanup_ran')
    })
  
    await write_marker('ready', 'ready')
  
    try {
      await new Promise<void>((_resolve, reject) => {
        const deadline = setTimeout(() => {
          reject(new Error('harness timeout: SIGINT never arrived'))
        }, 70_000)
        ctx.abort.addEventListener(
          'abort',
          () => {
            clearTimeout(deadline)
            const reason = ctx.abort.reason
            reject(reason instanceof Error ? reason : new Error(`aborted: ${String(reason)}`))
          },
          { once: true },
        )
      })
      return 0
    } catch (io_error) {
      const reason = ctx.abort.reason
      const payload = {
        reason_is_aborted_error: reason instanceof aborted_error,
        reason_name: reason instanceof Error ? reason.name : typeof reason,
        reason_message: reason instanceof Error ? reason.message : String(reason),
        io_error_name: io_error instanceof Error ? io_error.name : typeof io_error,
      }
      await write_marker('abort-reason.json', JSON.stringify(payload))
      throw io_error
    }
  })

  await run(long_running, 0)
}

async function write_exit_reason(error: unknown): Promise<void> {
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  await writeFile(
    join(marker_dir, 'exit-reason.json'),
    JSON.stringify({ name, message, is_aborted_error: error instanceof aborted_error }),
  )
}

try {
  await main()
  process.exit(0)
} catch (error: unknown) {
  try {
    await write_exit_reason(error)
  } finally {
    process.exit(1)
  }
}
