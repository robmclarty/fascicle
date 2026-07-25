/**
 * run_command: execute an argv array inside the sandbox.
 *
 * Takes argv, not a shell string. Pipelines and redirects are unsupported on
 * purpose — the agent composes those out of multiple tool calls. If a variant
 * needs shell semantics, wire it through a dedicated container exec inside
 * `docker_sandbox`, not a host-level `/bin/sh -c`.
 */

import type { Tool } from 'fascicle'
import { z } from 'zod'

import type { Sandbox } from '../sandbox.js'
import { clip, DEFAULT_COMMAND_TIMEOUT_MS } from './limits.js'

const run_command_input = z.object({
  argv: z.array(z.string()).min(1),
  timeout_ms: z.number().int().positive().optional(),
})

export function make_run_command(sandbox: Sandbox): Tool {
  return {
    name: 'run_command',
    description: `Run a command inside the sandbox. Pass argv as an array (no shell). For pipelines or redirects, write the result to a file via write_file first. Default timeout is ${String(DEFAULT_COMMAND_TIMEOUT_MS)}ms.`,
    input_schema: run_command_input,
    execute: async (raw) => {
      const input = run_command_input.parse(raw)
      const timeout_ms = input.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS
      const result = await sandbox.exec(input.argv, { timeout_ms })
      return {
        stdout: clip(result.stdout),
        stderr: clip(result.stderr),
        exit_code: result.exit_code,
      }
    },
  }
}
