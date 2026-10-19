/**
 * Process glue for serving a flow as an ACP agent over stdio.
 *
 * Binds `serve_streams` to the real process: ndjson in on stdin, the
 * protocol out on stdout, and nothing else on stdout ever. A stray log line
 * from a flow or a dependency would corrupt the protocol stream, so
 * `console.log`, `console.info`, `console.debug`, `console.dir`, and
 * `console.dirxml` go to stderr for the life of the process.
 *
 * SIGTERM and SIGINT abort every active run, dispose the engine, and exit.
 * A host that ends the agent with a signal instead of closing stdin would
 * otherwise leave a run's work going after the editor has closed, since each
 * turn runs with the runner's own signal handlers off. The handlers are
 * one-shot, so a second Ctrl-C falls through to Node's default and kills the
 * process outright when a shutdown hangs.
 *
 * Excluded from mutation testing as process glue (see stryker.config.mjs);
 * the spawn tests in `__tests__/e2e/` exercise it for real.
 */

import { constants } from 'node:os'
import { Readable, Writable } from 'node:stream'
import { aborted_error } from '#core'
import { route_console_to_stderr } from '#process'
import { serve_streams } from './serve_streams.js'
import type { ServeAcpConfig } from './types.js'

/**
 * Serve a flow as an ACP agent over stdin and stdout until the client
 * disconnects, disposing the engine once every active run has been aborted.
 * A SIGTERM or SIGINT does the same, then exits with the signal's code.
 */
export async function serve_acp<i, o>(config: ServeAcpConfig<i, o>): Promise<void> {
  // Leave stdout to the protocol alone.
  route_console_to_stderr(console, process.stderr)
  const shutdown = new AbortController()
  let received: NodeJS.Signals | null = null
  const on_signal = (signal: NodeJS.Signals): void => {
    received = signal
    shutdown.abort(new aborted_error(`received ${signal}`, { reason: { signal } }))
  }
  process.once('SIGTERM', on_signal)
  process.once('SIGINT', on_signal)
  try {
    await serve_streams(config, {
      input: Readable.toWeb(process.stdin),
      output: Writable.toWeb(process.stdout),
      shutdown: shutdown.signal,
    })
  } finally {
    process.off('SIGTERM', on_signal)
    process.off('SIGINT', on_signal)
  }
  // Exiting here rather than draining tells the host a signal ended the
  // agent, and leaves no wait on a flow that ignored its abort.
  if (received !== null) process.exit(128 + constants.signals[received])
}
