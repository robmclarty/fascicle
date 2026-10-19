/**
 * console: keep a process's console off its stdout.
 *
 * A process whose stdout carries something a parent reads (the ACP protocol
 * under `serve_acp`, the one result document under `run_stdio`) breaks when a
 * flow or a dependency logs, because `console.log` writes to stdout by
 * default. Routing the console's stdout methods to stderr keeps that stream
 * to its one job.
 */

import { Console } from 'node:console'
import type { InspectOptions } from 'node:util'

/**
 * Route `target`'s stdout methods (`log`, `info`, `debug`, `dirxml`, and
 * `dir`) to stderr for as long as `target` lives.
 *
 * Four of them call `target.error`, which already writes to stderr. `dir`
 * writes to its console's own stream rather than through `log`, so it comes
 * from a console bound to `stderr`, which honors options such as `depth`.
 * A write that goes straight to `process.stdout` still lands there.
 */
export function route_console_to_stderr(target: typeof console, stderr: NodeJS.WritableStream): void {
  const stderr_console = new Console(stderr)
  const to_stderr = target.error.bind(target)
  Object.assign(target, {
    log: to_stderr,
    info: to_stderr,
    debug: to_stderr,
    dirxml: to_stderr,
    dir: (item: unknown, options?: InspectOptions) => {
      stderr_console.dir(item, options)
    },
  })
}
