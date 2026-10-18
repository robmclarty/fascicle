/**
 * write_file: overwrite one repository file through the sandbox boundary.
 */

import { define_tool } from 'fascicle'
import type { Tool } from 'fascicle'
import { z } from 'zod'

import type { Sandbox } from '../sandbox.js'

const write_file_input = z.object({ path: z.string(), contents: z.string() })

export function make_write_file(sandbox: Sandbox): Tool {
  return define_tool({
    name: 'write_file',
    description:
      'Overwrite a file in the repository with new contents. Creates parent directories as needed.',
    input_schema: write_file_input,
    execute: async (input) => {
      await sandbox.write_file(input.path, input.contents)
      return { ok: true }
    },
  })
}
