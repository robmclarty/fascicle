/**
 * list_dir: list immediate entries of a directory inside the worktree.
 *
 * Accepts a path relative to the worktree root (use "." for the root).
 * Symlinked leaves are refused on principle. Output is capped at
 * MAX_LIST_ENTRIES; the model sees `truncated: true` when more entries
 * exist beyond the cap.
 */

import { readdir, stat } from 'node:fs/promises'
import { z } from 'zod'

import type { Tool } from 'fascicle'

import { MAX_LIST_ENTRIES } from './limits.js'
import { assert_not_symlink, resolve_within } from './path_safety.js'

export type EntryKind = 'file' | 'dir' | 'symlink' | 'other'

export type Entry = {
  readonly name: string
  readonly kind: EntryKind
}

export const list_dir_input = z.object({
  path: z.string().min(1),
})

export type ListDirOutput = {
  readonly path: string
  readonly entries: ReadonlyArray<Entry>
  readonly truncated: boolean
}

export function make_list_dir(root: string): Tool {
  return {
    name: 'list_dir',
    description:
      'List the immediate entries of a directory inside the PR worktree. ' +
      'Pass "." for the worktree root. Returns up to ' +
      String(MAX_LIST_ENTRIES) +
      ' entries; truncated: true means more were available.',
    input_schema: list_dir_input,
    execute: async (raw) => {
      const input = list_dir_input.parse(raw)
      const resolved = resolve_within(root, input.path)
      await assert_not_symlink(resolved, input.path)
      const target_stat = await stat(resolved)
      if (!target_stat.isDirectory()) {
        throw new Error(`not a directory: ${input.path}`)
      }
      const raw_entries = await readdir(resolved, { withFileTypes: true })
      const truncated = raw_entries.length > MAX_LIST_ENTRIES
      const slice = truncated ? raw_entries.slice(0, MAX_LIST_ENTRIES) : raw_entries
      const entries: Entry[] = slice.map((d) => ({
        name: d.name,
        kind: d.isFile()
          ? 'file'
          : d.isDirectory()
            ? 'dir'
            : d.isSymbolicLink()
              ? 'symlink'
              : 'other',
      }))
      const out: ListDirOutput = { path: input.path, entries, truncated }
      return out
    },
  }
}
