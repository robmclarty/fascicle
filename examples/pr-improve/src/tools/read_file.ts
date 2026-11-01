/**
 * read_file: read a utf-8 text file inside the worktree.
 *
 * Caps file size at MAX_FILE_BYTES. Refuses symlinked targets and binary
 * content (NUL byte detection). Returns content plus byte and line counts
 * so the model can budget further calls.
 */

import { z } from 'zod'

import { define_tool } from 'fascicle'
import type { Tool } from 'fascicle'

import { MAX_FILE_BYTES } from './limits.js'
import { read_text_within } from './read_text.js'

export const read_file_input = z.object({
  path: z.string().min(1),
})

export type ReadFileOutput = {
  readonly path: string
  readonly content: string
  readonly bytes: number
  readonly lines: number
}

export function make_read_file(root: string): Tool {
  return define_tool({
    name: 'read_file',
    description:
      'Read a utf-8 text file inside the PR worktree. Refuses symlinks and ' +
      'binary content. Files larger than ' +
      String(MAX_FILE_BYTES) +
      ' bytes are rejected.',
    input_schema: read_file_input,
    execute: async (input) => {
      const { buffer } = await read_text_within(root, input.path, 'read')
      const content = buffer.toString('utf8')
      const lines = content.length === 0 ? 0 : content.split('\n').length
      return { path: input.path, content, bytes: buffer.byteLength, lines }
    },
  })
}
