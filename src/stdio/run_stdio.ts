/**
 * Process glue for the stdio agent contract.
 *
 * Binds `execute_stdio` to the real process: stdin to EOF in, exactly one JSON
 * document on stdout out, trajectory on stderr, exit code as the verdict
 * (0 = result on stdout is authoritative, 1 = flow failure, 2 = contract
 * violation). On a non-zero exit the LAST stderr line is the `StdioFailure`
 * as a single JSON object, so parents that want machine-readable detail take
 * the tail line.
 *
 * Final writes await the write callback before `process.exit`: on pipes,
 * exiting with buffered data truncates it, and a large JSON result is exactly
 * the risk case. Signal handlers stay at the runner's default (installed): a
 * single-shot child must die when the parent forwards SIGINT.
 *
 * Excluded from mutation testing as process/IO glue (see stryker.config.mjs);
 * the spawn-based contract tests in `__tests__/e2e/` exercise it for real.
 */

import { text } from 'node:stream/consumers'
import type { Step } from '#core'
import { execute_stdio } from './execute_stdio.js'
import type { RunStdioOptions } from './execute_stdio.js'

/**
 * Runs a flow as the stdio agent contract against the real process streams,
 * then exits with the outcome's code.
 *
 * On a non-zero outcome, writes the `StdioFailure` as the last line on
 * stderr so a parent process can take the tail line as machine-readable
 * detail.
 */
export async function run_stdio<i, o>(
  flow: Step<i, o>,
  options: RunStdioOptions<i, o> = {},
): Promise<void> {
  const outcome = await execute_stdio(flow, options, {
    read_input: () => text(process.stdin),
    write_output: (chunk) => write_flushed(process.stdout, chunk),
    error_stream: process.stderr,
  })
  if (outcome.code !== 0) {
    try {
      await write_flushed(process.stderr, `${JSON.stringify(outcome.failure)}\n`)
    } catch {
      // stderr is gone; the exit code still carries the verdict.
    }
  }
  process.exit(outcome.code)
}

/**
 * Writes a chunk to a stream and resolves only once it is flushed, so the
 * caller can safely exit the process afterward without truncating output.
 */
function write_flushed(stream: NodeJS.WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}
