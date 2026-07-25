/**
 * list_files: list one directory inside the sandbox.
 */

import type { Tool } from 'fascicle'
import { z } from 'zod'

import type { Sandbox } from '../sandbox.js'

const list_files_input = z.object({ path: z.string().optional() })

export function make_list_files(sandbox: Sandbox): Tool {
  return {
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
}
