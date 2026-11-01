/**
 * read_text_within: the guards read_file and edit_file share before either
 * touches a file's content.
 *
 * The target must resolve inside the worktree, be a regular file and not a
 * symlink, fit under MAX_FILE_BYTES, and hold no NUL byte, which marks it as
 * binary. Returns the resolved path along with the bytes, since edit_file
 * writes back to it.
 */

import { lstat, readFile } from 'node:fs/promises'

import { MAX_FILE_BYTES } from './limits.js'
import { assert_not_symlink, resolve_within } from './path_safety.js'

export type TextFile = {
  readonly resolved: string
  readonly buffer: Buffer
}

export async function read_text_within(
  root: string,
  user_path: string,
  verb: 'read' | 'edit',
): Promise<TextFile> {
  const resolved = resolve_within(root, user_path)
  await assert_not_symlink(resolved, user_path)
  const target_stat = await lstat(resolved)
  if (!target_stat.isFile()) {
    throw new Error(`not a regular file: ${user_path}`)
  }
  if (target_stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `file exceeds size cap: ${user_path} is ${String(target_stat.size)} bytes, max ${String(MAX_FILE_BYTES)}`,
    )
  }
  const buffer = await readFile(resolved)
  if (buffer.includes(0)) {
    throw new Error(`refusing to ${verb} binary file (NUL byte present): ${user_path}`)
  }
  return { resolved, buffer }
}
