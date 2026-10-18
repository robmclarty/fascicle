/**
 * read_file: read one repository file through the sandbox boundary.
 */

import { define_tool } from 'fascicle'
import type { Tool } from 'fascicle'
import { z } from 'zod'

import type { Sandbox } from '../sandbox.js'
import { clip, MAX_FILE_BYTES } from './limits.js'

const read_file_input = z.object({ path: z.string() })

export function make_read_file(sandbox: Sandbox): Tool {
  return define_tool({
    name: 'read_file',
    description: `Read a file from the repository, relative to the working directory. Truncates after ${String(MAX_FILE_BYTES)} bytes.`,
    input_schema: read_file_input,
    execute: async (input) => {
      const contents = await sandbox.read_file(input.path)
      return { contents: clip(contents) }
    },
  })
}
