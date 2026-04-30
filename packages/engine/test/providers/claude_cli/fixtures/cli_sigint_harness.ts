/**
 * Cross-layer SIGINT harness (spec §12 #26 / §10 criterion 9).
 *
 * Spawns @repo/core.run(step(engine.generate)) where the engine has a
 * claude_cli adapter wired to the mock binary. The mock hangs until signalled.
 * When this harness receives SIGINT, core's signal handler aborts the run
 * controller, the engine propagates into the claude_cli adapter, which sends
 * SIGTERM to the mock subprocess. The harness writes marker files so the
 * parent test can assert behaviour.
 *
 * Env inputs:
 *   - MARKER_DIR       — directory where marker files are written
 *   - MOCK_CLAUDE_BIN  — absolute path to mock_claude.mjs
 *   - MOCK_SCRIPT      — path to the mock ops JSON (script with {op:'hang'})
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run } from '../../../../../core/src/runner.js'
import { step } from '../../../../../core/src/step.js'
import { create_engine } from '../../../../src/create_engine.js'
import {
  aborted_error as engine_aborted_error,
} from '../../../../src/errors.js'

function require_env(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') {
    process.stderr.write(`${name} not set\n`)
    process.exit(2)
  }
  return v
}

const marker_dir = require_env('MARKER_DIR')
const mock_bin = require_env('MOCK_CLAUDE_BIN')
const mock_script = require_env('MOCK_SCRIPT')

async function write_marker(name: string, body: string): Promise<void> {
  await writeFile(join(marker_dir, name), body)
}

async function main(): Promise<void> {
  const engine = create_engine({
    providers: { claude_cli: { binary: mock_bin, auth_mode: 'oauth' } },
  })

  const cli_flow = step('cli_call', async (_input: number, ctx) => {
    ctx.on_cleanup(async () => {
      await write_marker('cleanup.first.ok', 'first')
    })
    ctx.on_cleanup(async () => {
      await write_marker('cleanup.second.ok', 'second')
    })
  
    await write_marker('ready', 'ready')
  
    try {
      const result = await engine.generate({
        model: 'cli-sonnet',
        prompt: 'hang please',
        abort: ctx.abort,
        provider_options: {
          claude_cli: {
            env: {
              PATH: process.env['PATH'] ?? '',
              MOCK_CLAUDE_SCRIPT: mock_script,
            },
          },
        },
      })
      return result.content
    } catch (err) {
      await write_marker(
        'engine-error.json',
        JSON.stringify({
          is_engine_aborted_error: err instanceof engine_aborted_error,
          name: err instanceof Error ? err.name : typeof err,
          message: err instanceof Error ? err.message : String(err),
        }),
      )
      throw err
    }
  })

  await run(cli_flow, 0)
}

try {
  await main()
  process.exit(0)
} catch (error: unknown) {
  try {
    await writeFile(
      join(marker_dir, 'exit-reason.json'),
      JSON.stringify({
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        is_engine_aborted_error: error instanceof engine_aborted_error,
      }),
    )
  } finally {
    process.exit(1)
  }
}
