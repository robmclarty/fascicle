/**
 * list_files: list the workspace's files that match a glob.
 *
 * It walks the directory itself and matches each file with `path`'s
 * `matchesGlob`, rather than handing the walk to `fs/promises`' `glob`.
 * That `glob` steps through a symlinked directory whenever a pattern names
 * it, passes over its `exclude` callback for a pattern that names its
 * segments, swallows a directory it can't read, and, with an `exclude`
 * callback under Stryker's runner, can drop a whole directory it has already
 * listed. The walk here never follows a symlink and never enters an ignored
 * name, so every file it lists lies under the searched directory, which
 * `contain` has already placed inside a root, and its matches follow the
 * same glob rules as `glob`'s.
 */

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, matchesGlob } from 'node:path'
import type { Tool } from '#engine'
import { as_record, json_schema_to_standard } from '#schema'
import type { AcpSession } from '../types.js'
import { contain, shown_path } from './containment.js'

/** What `list_files` matches when the call names no pattern. */
const ALL_FILES = '**/*'

/** One listing: the glob, and the directory it runs in, as the model gave them. */
type ListRequest = {
  readonly pattern: string
  readonly path: string
}

/** What one walk needs besides the directory it's in. */
export type Walk = {
  readonly pattern: string
  readonly ignored: ReadonlySet<string>
  readonly abort: AbortSignal
  readonly found: string[]
}

/**
 * Read the call's pattern and directory out of its input, refusing a
 * pattern that reaches past the directory: it could never match, and the
 * model is better told to pass the directory as `path`.
 */
function list_request(input: unknown): ListRequest {
  const fields: Record<string, unknown> = as_record(input) ?? {}
  const { pattern = ALL_FILES, path = '.' } = fields
  if (typeof pattern !== 'string' || typeof path !== 'string') {
    throw new Error('list_files takes its pattern and path as strings')
  }
  if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
    throw new Error(
      `list_files matches its pattern under path, so ${pattern} can't be absolute or climb with ..; pass the directory as path instead`,
    )
  }
  return { pattern, path }
}

/**
 * Walk one directory, depth first: descend into each subdirectory and keep
 * each regular file that matches, skipping ignored names. A symlink is
 * neither a directory nor a file to a `readdir` entry, so the walk never
 * follows one. `search` walks with it too, so both tools see the same files.
 */
export async function walk(directory: string, below: string, work: Walk): Promise<void> {
  work.abort.throwIfAborted()
  const entries: Dirent[] = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (work.ignored.has(entry.name)) continue
    const relative = join(below, entry.name)
    if (entry.isDirectory()) await walk(join(directory, entry.name), relative, work)
    else if (entry.isFile() && matchesGlob(relative, work.pattern)) work.found.push(relative)
  }
}

/**
 * The files under the request's directory that match its pattern, in the
 * model's terms and sorted.
 */
async function matching_files(
  session: AcpSession,
  request: ListRequest,
  ignored: ReadonlySet<string>,
  abort: AbortSignal,
): Promise<string[]> {
  const base = await contain(session, request.path)
  if (!(await stat(base.real)).isDirectory()) {
    throw new Error(`${request.path} is a file; list_files lists a directory, and read_file reads a file`)
  }
  const found: string[] = []
  await walk(base.real, '', { pattern: request.pattern, ignored, abort, found })
  return found.map((relative) => shown_path(session, join(base.path, relative))).toSorted()
}

/**
 * The files as the model reads them, one to a line, and past `limit` the
 * first `limit` of them with a note giving the total. The walk has already
 * found every match to sort them, so the total costs nothing to count.
 */
function listing(files: ReadonlyArray<string>, limit: number): string {
  if (files.length <= limit) return files.join('\n')
  const note = `[the first ${limit} of ${files.length} files; narrow pattern or path to see the rest]`
  return [...files.slice(0, limit), '', note].join('\n')
}

/**
 * The `list_files` tool for one session: the files under a directory in
 * its workspace that match a glob, skipping the `ignore` names, at most
 * `limit` per call.
 */
export function list_files_tool(session: AcpSession, ignore: ReadonlyArray<string>, limit: number): Tool {
  const ignored = new Set(ignore)
  return {
    name: 'list_files',
    description: [
      `List the files in the workspace that match a glob pattern, one per line and at most ${limit} per call; a path under the workspace root is shown relative to it.`,
      `The pattern matches under path (default: the workspace root) and defaults to ${ALL_FILES}.`,
      'As in a shell, * and ** skip names that start with a dot, so name the dot to list hidden files (.github/**/*).',
      ...(ignore.length === 0 ? [] : [`Skips ${ignore.join(', ')}.`]),
    ].join(' '),
    input_schema: json_schema_to_standard({
      type: 'object',
      properties: {
        pattern: { type: 'string', description: `A glob such as src/**/*.ts; default: ${ALL_FILES}` },
        path: {
          type: 'string',
          description: 'The directory to search, absolute or relative to the workspace root; default: the root',
        },
      },
      additionalProperties: false,
    }),
    execute: async (input, ctx) => {
      const request = list_request(input)
      const files = await matching_files(session, request, ignored, ctx.abort)
      return files.length === 0 ? `no files match ${request.pattern} under ${request.path}` : listing(files, limit)
    },
  }
}
