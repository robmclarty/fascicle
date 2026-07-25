/**
 * grep_files: recursive regex search inside the sandbox.
 */

import type { Tool } from 'fascicle'
import { z } from 'zod'

import type { Sandbox } from '../sandbox.js'
import { clip, MAX_GREP_MATCHES } from './limits.js'

const grep_input = z.object({ pattern: z.string(), path: z.string().optional() })

export function make_grep_files(sandbox: Sandbox): Tool {
  return {
    name: 'grep_files',
    description: `Search for a regex pattern in the repository (recursive). Returns up to ${String(MAX_GREP_MATCHES)} matching lines with file:line prefixes.`,
    input_schema: grep_input,
    execute: async (raw) => {
      const input = grep_input.parse(raw)
      const path = input.path ?? '.'
      const result = await sandbox.exec([
        'grep',
        '-rnI',
        `--max-count=${String(MAX_GREP_MATCHES)}`,
        input.pattern,
        path,
      ])
      return { matches: clip(result.stdout) }
    },
  }
}
