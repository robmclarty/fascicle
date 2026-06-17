/**
 * edit_file: string-replace within a file inside the worktree.
 *
 * Default semantics mirror Claude Code's Edit tool: `find` must match
 * exactly once. Zero matches and ambiguous (>1) matches both error so the
 * model is forced to add unique surrounding context. Pass `replace_all:
 * true` to override and replace every occurrence.
 *
 * The post-edit content is also bounded by MAX_FILE_BYTES so a tiny
 * `find` paired with a giant `replace` can't smuggle past the limit.
 */

import { lstat, readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'

import type { Tool } from 'fascicle'

import { MAX_FILE_BYTES } from './limits.js'
import { assert_not_symlink, resolve_within } from './path_safety.js'

export const edit_file_input = z.object({
  path: z.string().min(1),
  find: z.string().min(1),
  replace: z.string(),
  replace_all: z.boolean().optional(),
})

export type EditFileOutput = {
  readonly path: string
  readonly replacements: number
  readonly bytes_written: number
}

export function make_edit_file(root: string): Tool {
  return {
    name: 'edit_file',
    description:
      'String-replace within a file in the PR worktree. By default `find` must ' +
      'match exactly once; ambiguous or missing matches error. Pass ' +
      'replace_all: true to replace every occurrence.',
    input_schema: edit_file_input,
    execute: async (raw) => {
      const input = edit_file_input.parse(raw)
      const resolved = resolve_within(root, input.path)
      await assert_not_symlink(resolved, input.path)
      const target_stat = await lstat(resolved)
      if (!target_stat.isFile()) {
        throw new Error(`not a regular file: ${input.path}`)
      }
      if (target_stat.size > MAX_FILE_BYTES) {
        throw new Error(
          `file exceeds size cap: ${input.path} is ${String(target_stat.size)} bytes`,
        )
      }
      const buffer = await readFile(resolved)
      if (buffer.includes(0)) {
        throw new Error(`refusing to edit binary file (NUL byte present): ${input.path}`)
      }
      const before = buffer.toString('utf8')
      const occurrences = count_occurrences(before, input.find)
      if (occurrences === 0) {
        throw new Error(`find string not found in ${input.path}`)
      }
      if (occurrences > 1 && input.replace_all !== true) {
        throw new Error(
          `find string is ambiguous in ${input.path} (${String(occurrences)} occurrences); ` +
            `add unique surrounding context or pass replace_all: true`,
        )
      }
      const after =
        input.replace_all === true
          ? before.split(input.find).join(input.replace)
          : before.replace(input.find, input.replace)
      const after_bytes = Buffer.byteLength(after, 'utf8')
      if (after_bytes > MAX_FILE_BYTES) {
        throw new Error(
          `post-edit content exceeds size cap: ${String(after_bytes)} bytes`,
        )
      }
      await writeFile(resolved, after, { encoding: 'utf8' })
      return { path: input.path, replacements: occurrences, bytes_written: after_bytes }
    },
  }
}

function count_occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) return count
    count += 1
    from = idx + needle.length
  }
}
