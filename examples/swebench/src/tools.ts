/**
 * Tools the model gets while solving a SWE-bench instance.
 *
 * Each tool closes over a per-case `Sandbox` so all filesystem and shell
 * effects route through the same isolation boundary as the eventual eval.
 * The tools are intentionally small and POSIX-flavored — see the SWE-agent
 * "Agent–Computer Interface" rationale: a constrained, model-friendly
 * command surface beats a kitchen-sink toolset.
 *
 * Constructed per case (not at module scope) because the sandbox handle is
 * per case; this is the seam that decouples tool identity from sandbox
 * identity.
 *
 * `run_command` takes an argv array, not a shell string. Pipelines and
 * redirects are not supported on purpose — the agent composes those out of
 * multiple tool calls. If a future variant needs shell semantics, wire it
 * through a dedicated container exec inside `docker_sandbox`, not through
 * a host-level `/bin/sh -c`.
 */

import { z } from 'zod'
import type { Tool } from '@repo/fascicle'
import type { Sandbox } from './sandbox.js'

const read_file_input = z.object({ path: z.string() })
const write_file_input = z.object({ path: z.string(), contents: z.string() })
const run_command_input = z.object({
  argv: z.array(z.string()).min(1),
  timeout_ms: z.number().int().positive().optional(),
})
const list_files_input = z.object({ path: z.string().optional() })
const grep_input = z.object({ pattern: z.string(), path: z.string().optional() })

const MAX_FILE_BYTES = 100_000

function clip(text: string, max = MAX_FILE_BYTES): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated ${String(text.length - max)} bytes]`
}

export function build_tools(sandbox: Sandbox): ReadonlyArray<Tool> {
  const read_file: Tool = {
    name: 'read_file',
    description: 'Read a file from the repository, relative to the working directory. Truncates after 100k bytes.',
    input_schema: read_file_input,
    execute: async (raw) => {
      const input = read_file_input.parse(raw)
      const contents = await sandbox.read_file(input.path)
      return { contents: clip(contents) }
    },
  }

  const write_file: Tool = {
    name: 'write_file',
    description: 'Overwrite a file in the repository with new contents. Creates parent directories as needed.',
    input_schema: write_file_input,
    execute: async (raw) => {
      const input = write_file_input.parse(raw)
      await sandbox.write_file(input.path, input.contents)
      return { ok: true }
    },
  }

  const run_command: Tool = {
    name: 'run_command',
    description: 'Run a command inside the sandbox. Pass argv as an array (no shell). For pipelines/redirects, write the result to a file via write_file first. Default timeout is 60s.',
    input_schema: run_command_input,
    execute: async (raw) => {
      const input = run_command_input.parse(raw)
      const timeout_ms = input.timeout_ms ?? 60_000
      const result = await sandbox.exec(input.argv, { timeout_ms })
      return {
        stdout: clip(result.stdout),
        stderr: clip(result.stderr),
        exit_code: result.exit_code,
      }
    },
  }

  const list_files: Tool = {
    name: 'list_files',
    description: 'List the contents of a directory, defaulting to the repository root.',
    input_schema: list_files_input,
    execute: async (raw) => {
      const input = list_files_input.parse(raw)
      const path = input.path ?? '.'
      const result = await sandbox.exec(['ls', '-1', path])
      const entries = result.stdout.split('\n').filter((line) => line.length > 0)
      return { entries }
    },
  }

  const grep_files: Tool = {
    name: 'grep_files',
    description: 'Search for a regex pattern in the repository (recursive). Returns up to 200 matching lines with file:line prefixes.',
    input_schema: grep_input,
    execute: async (raw) => {
      const input = grep_input.parse(raw)
      const path = input.path ?? '.'
      const result = await sandbox.exec(['grep', '-rnI', '--max-count=200', input.pattern, path])
      return { matches: clip(result.stdout) }
    },
  }

  return [read_file, write_file, run_command, list_files, grep_files]
}
