/**
 * read_file: read a text file in the workspace with its lines numbered, a
 * window at a time.
 *
 * A window stops at `read_limit_lines` and says where the next one starts,
 * and a line past LINE_WIDTH characters is cut with a marker, because a
 * minified bundle or a source map can be one line of megabytes and nothing
 * else keeps it out of the model's context. A file with a NUL byte in its
 * first 8 KB is refused as binary. The file streams line by line, so a
 * window near the top of a huge file reads only as far as it shows.
 */

import { open, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Tool } from '#engine'
import { as_record, json_schema_to_standard } from '#schema'
import type { AcpSession } from '../types.js'
import { contain, error_code } from './containment.js'

/** The longest line `read_file` returns whole, the width Claude Code's Read cuts at. */
const LINE_WIDTH = 2000

/** How much of a file's head is checked for a NUL byte, the sign of a binary file. */
const BINARY_SNIFF_BYTES = 8192

/** One read: the path as the model gave it, and the lines it covers. */
type ReadRequest = {
  readonly path: string
  readonly offset: number
  readonly limit: number
}

/**
 * Whether a value counts lines: a whole number of at least 1.
 */
function is_count(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1
}

/**
 * Read the call's window out of its input, with `limit` held to the cap.
 * The tool loop has already checked the types against the schema, but a
 * flow that wraps the tool can call `execute` directly, and the schema's
 * `minimum` is advice to the model rather than something the loop enforces.
 */
function read_request(input: unknown, read_limit_lines: number): ReadRequest {
  const fields: Record<string, unknown> = as_record(input) ?? {}
  const { path, offset = 1, limit = read_limit_lines } = fields
  if (typeof path !== 'string') throw new Error('read_file needs a path, as a string')
  if (!is_count(offset) || !is_count(limit)) {
    throw new Error('read_file counts offset and limit in lines from 1, so each has to be a whole number of at least 1')
  }
  return { path, offset, limit: Math.min(limit, read_limit_lines) }
}

/**
 * Whether the file's first BINARY_SNIFF_BYTES hold a NUL byte. `search`
 * skips a file this calls binary, so the two tools agree on what is text.
 */
export async function is_binary(handle: FileHandle): Promise<boolean> {
  const head = Buffer.alloc(BINARY_SNIFF_BYTES)
  const { bytesRead } = await handle.read(head, 0, BINARY_SNIFF_BYTES, 0)
  return head.subarray(0, bytesRead).includes(0)
}

/**
 * One line as the model sees it: its number, a tab, and its text, cut at
 * LINE_WIDTH with a marker that says how long it was.
 */
function numbered(line_number: number, line: string): string {
  const text =
    line.length > LINE_WIDTH ? `${line.slice(0, LINE_WIDTH)} [line cut at ${LINE_WIDTH} of ${line.length} characters]` : line
  return `${String(line_number).padStart(6)}\t${text}`
}

/**
 * Number the window's lines, reading one line past it to learn whether the
 * file goes on, and say where to start the next read when it does.
 */
async function read_lines(handle: FileHandle, request: ReadRequest): Promise<string> {
  const last = request.offset + request.limit - 1
  const shown: string[] = []
  let count = 0
  let more = false
  // The binary check reads at an explicit position, which leaves the
  // handle's own position at the top, where these lines start.
  for await (const line of handle.readLines()) {
    count += 1
    if (count > last) {
      more = true
      break
    }
    if (count >= request.offset) shown.push(numbered(count, line))
  }
  if (count === 0) return `${request.path} is empty`
  if (shown.length === 0) {
    throw new Error(`offset ${request.offset} is past the end of ${request.path}, which has ${count} lines`)
  }
  const body = shown.join('\n')
  if (!more) return body
  return `${body}\n\n[lines ${request.offset} to ${last} shown; the file goes on, so read on with offset ${last + 1}]`
}

/**
 * Read a contained file's window, refusing what isn't a regular text file.
 * The type is checked before the file opens, since opening a FIFO would
 * wait for a writer that never comes.
 */
async function read_contained(real: string, request: ReadRequest): Promise<string> {
  const info = await stat(real).catch((err: unknown) => {
    throw error_code(err) === 'ENOENT' ? new Error(`${request.path} doesn't exist`) : err
  })
  if (info.isDirectory()) throw new Error(`${request.path} is a directory; list_files shows what's in it`)
  if (!info.isFile()) throw new Error(`${request.path} isn't a regular file, so read_file can't read it`)
  const handle = await open(real)
  try {
    if (await is_binary(handle)) {
      throw new Error(`${request.path} is a binary file (it has a NUL byte in its first 8 KB), so read_file won't read it`)
    }
    return await read_lines(handle, request)
  } finally {
    await handle.close()
  }
}

/**
 * The `read_file` tool for one session: numbered lines from a file inside
 * its workspace, at most `read_limit_lines` per call.
 */
export function read_file_tool(session: AcpSession, read_limit_lines: number): Tool {
  return {
    name: 'read_file',
    description:
      `Read a text file in the workspace. Returns its lines numbered from 1, at most ${read_limit_lines} per call; ` +
      `pass offset (the first line to read) and limit to read part of a longer file. ` +
      `Lines over ${LINE_WIDTH} characters are cut. The path is absolute or relative to the workspace root.`,
    input_schema: json_schema_to_standard({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to read, absolute or relative to the workspace root' },
        offset: { type: 'integer', minimum: 1, description: 'The first line to read, counting from 1; default: 1' },
        limit: {
          type: 'integer',
          minimum: 1,
          description: `How many lines to read; default and most: ${read_limit_lines}`,
        },
      },
      required: ['path'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const request = read_request(input, read_limit_lines)
      const { real } = await contain(session, request.path)
      return read_contained(real, request)
    },
  }
}
