/**
 * read_file: read a utf-8 text file inside the worktree.
 *
 * Caps file size at MAX_FILE_BYTES. Refuses symlinked targets and binary
 * content (NUL byte detection). Returns content plus byte and line counts
 * so the model can budget further calls.
 */

import { readFile, stat } from 'node:fs/promises'
import { z } from 'zod'

import type { Tool } from '@repo/fascicle'

import { MAX_FILE_BYTES } from './limits.js'
import { assert_not_symlink, resolve_within } from './path_safety.js'

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
  return {
    name: 'read_file',
    description:
      'Read a utf-8 text file inside the PR worktree. Refuses symlinks and ' +
      'binary content. Files larger than ' +
      String(MAX_FILE_BYTES) +
      ' bytes are rejected.',
    input_schema: read_file_input,
    execute: async (raw) => {
      const input = read_file_input.parse(raw)
      const resolved = resolve_within(root, input.path)
      await assert_not_symlink(resolved, input.path)
      const target_stat = await stat(resolved)
      if (!target_stat.isFile()) {
        throw new Error(`not a regular file: ${input.path}`)
      }
      if (target_stat.size > MAX_FILE_BYTES) {
        throw new Error(
          `file exceeds size cap: ${input.path} is ${String(target_stat.size)} bytes, max ${String(MAX_FILE_BYTES)}`,
        )
      }
      const buffer = await readFile(resolved)
      if (buffer.includes(0)) {
        throw new Error(`refusing to read binary file (NUL byte present): ${input.path}`)
      }
      const content = buffer.toString('utf8')
      const lines = content.length === 0 ? 0 : content.split('\n').length
      return { path: input.path, content, bytes: buffer.byteLength, lines }
    },
  }
}
