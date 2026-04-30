/**
 * Engine SIGINT child harness.
 *
 * Runs a `run(step, ...)` flow whose body calls `engine.generate(...)`
 * streaming. The `ai` module and `@ai-sdk/anthropic` peer are replaced by
 * local ESM resolver stubs (see ai-stub.mjs, sdk-stub.mjs) so the provider
 * call hangs until the process receives SIGINT. On SIGINT, the runner aborts
 * its controller, the engine's internal controller cancels the in-flight
 * "stream", generate rejects with `aborted_error`, and the runner's cleanup
 * handlers fire in LIFO order.
 *
 * Environment inputs:
 *   - MARKER_DIR — directory where marker files are written.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { aborted_error as core_aborted_error } from '../../../core/src/errors.js'
import { run } from '../../../core/src/runner.js'
import { step } from '../../../core/src/step.js'
import { create_engine } from '../../src/create_engine.js'
import { aborted_error as engine_aborted_error } from '../../src/errors.js'

function require_marker_dir(): string {
  const value = process.env['MARKER_DIR']
  if (value === undefined || value === '') {
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
  const engine = create_engine({
    providers: { anthropic: { api_key: 'test-key' } },
  })

  const order: string[] = []

  const ai_flow = step('engine_generate', async (_input: number, ctx) => {
    ctx.on_cleanup(async () => {
      order.push('first')
      await write_marker('cleanup.first.ok', 'first')
    })
    ctx.on_cleanup(async () => {
      order.push('second')
      await write_marker('cleanup.second.ok', 'second')
    })
  
    await write_marker('ready', 'ready')
  
    try {
      const result = await engine.generate({
        model: 'claude-opus',
        prompt: 'hi',
        abort: ctx.abort,
        on_chunk: () => {},
      })
      return result.content
    } catch (err) {
      const payload = {
        is_engine_aborted_error: err instanceof engine_aborted_error,
        name: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      }
      await write_marker('engine-error.json', JSON.stringify(payload))
      throw err
    }
  })

  await run(ai_flow, 0)
}

async function write_exit_reason(error: unknown): Promise<void> {
  const is_core_aborted = error instanceof core_aborted_error
  const is_engine_aborted = error instanceof engine_aborted_error
  await writeFile(
    join(marker_dir, 'exit-reason.json'),
    JSON.stringify({
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      is_core_aborted_error: is_core_aborted,
      is_engine_aborted_error: is_engine_aborted,
    }),
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
