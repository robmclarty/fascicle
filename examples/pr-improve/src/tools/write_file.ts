/**
 * write_file: create or overwrite a utf-8 text file inside the worktree.
 *
 * Auto-creates parent directories within the worktree. Refuses to write
 * through symlinks or to overwrite a directory. Caps content at
 * MAX_FILE_BYTES (utf-8 byte length, not char count).
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

import type { Tool } from 'fascicle'

import { MAX_FILE_BYTES } from './limits.js'
import { assert_not_symlink, resolve_within } from './path_safety.js'

export const write_file_input = z.object({
  path: z.string().min(1),
  content: z.string(),
})

export type WriteFileOutput = {
  readonly path: string
  readonly bytes_written: number
  readonly created: boolean
}

export function make_write_file(root: string): Tool {
  return {
    name: 'write_file',
    description:
      'Write a utf-8 text file inside the PR worktree, overwriting if it exists. ' +
      'Auto-creates parent directories. Refuses symlinks and content larger than ' +
      String(MAX_FILE_BYTES) +
      ' bytes.',
    input_schema: write_file_input,
    execute: async (raw) => {
      const input = write_file_input.parse(raw)
      const bytes = Buffer.byteLength(input.content, 'utf8')
      if (bytes > MAX_FILE_BYTES) {
        throw new Error(
          `content exceeds size cap: ${String(bytes)} bytes, max ${String(MAX_FILE_BYTES)}`,
        )
      }
      const resolved = resolve_within(root, input.path)
      const existing = await maybe_stat(resolved)
      if (existing?.isDirectory() === true) {
        throw new Error(`refusing to overwrite directory: ${input.path}`)
      }
      await assert_not_symlink(resolved, input.path)
      await mkdir(dirname(resolved), { recursive: true })
      await writeFile(resolved, input.content, { encoding: 'utf8' })
      return {
        path: input.path,
        bytes_written: bytes,
        created: existing === undefined,
      }
    },
  }
}

async function maybe_stat(path: string): Promise<import('node:fs').Stats | undefined> {
  try {
    return await stat(path)
  } catch (err: unknown) {
    if (err !== null && typeof err === 'object' && (err as { code?: unknown }).code === 'ENOENT') {
      return undefined
    }
    throw err
  }
}
