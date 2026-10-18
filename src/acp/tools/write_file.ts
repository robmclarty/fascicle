/**
 * write_file: create a text file in the workspace, or replace everything one
 * holds.
 *
 * Every write is worked out before it happens, as the file's whole text
 * before and after, so the client can be shown the change as a diff before
 * anything reaches the disk. `edit_file` builds its change from the same
 * pieces, so the two tools agree on what they refuse and how they write.
 *
 * A write lands at the path's real location, which `contain` placed inside a
 * root, and creates the directories it needs there, so a model writing
 * `src/new/thing.ts` doesn't need a command to make `src/new` first.
 */

import { isUtf8 } from 'node:buffer'
import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Tool } from '#engine'
import { as_record, json_schema_to_standard } from '#schema'
import type { AcpSession } from '../types.js'
import { contain, error_code, shown_path } from './containment.js'
import type { ContainedPath } from './containment.js'
import { record_preview } from './previews.js'
import { is_binary } from './read_file.js'

/**
 * A write worked out before anything is written: the file both ways
 * `contain` names it, and its whole text before and after. `old_text` is
 * `null` only when the write creates the file.
 */
export type FileChange = ContainedPath & {
  readonly old_text: string | null
  readonly new_text: string
}

/** A file change as a card or a permission request shows it, with the line an edit lands on. */
export type ShownChange = FileChange & { readonly line?: number }

/**
 * The largest file a change reads, in bytes. A change is shown as a diff,
 * which carries the file's whole text twice, as its text before and after,
 * and the closing card update carries it again.
 */
const CHANGE_LIMIT_BYTES = 1_000_000

/** One write as the model asked for it. */
type WriteRequest = {
  readonly path: string
  readonly content: string
}

/**
 * Read the call's path and content out of its input.
 */
function write_request(input: unknown): WriteRequest {
  const fields: Record<string, unknown> = as_record(input) ?? {}
  const { path, content } = fields
  if (typeof path !== 'string' || typeof content !== 'string') {
    throw new Error('write_file needs a path and the content to write, as strings')
  }
  return { path, content }
}

/**
 * The text a write would replace, or `null` when no file is there yet.
 * Anything but a regular UTF-8 text file is refused, because the change is
 * shown as a diff of text, and rewriting a file in another encoding would
 * change bytes outside the edit. A file with other hard links is refused too:
 * a write changes the file under every name it has, and real paths can't say
 * where the other names lie. A file over CHANGE_LIMIT_BYTES is refused from
 * its size, before it's opened. `shown` is the path as the model gave it,
 * and `tool` names the tool asking, for the refusals.
 */
export async function current_text(real: string, shown: string, tool: string): Promise<string | null> {
  const info = await stat(real).catch((err: unknown) => {
    if (error_code(err) === 'ENOENT') return undefined
    throw err
  })
  if (info === undefined) return null
  if (info.isDirectory()) throw new Error(`${shown} is a directory; ${tool} changes a file, so name one inside it`)
  if (!info.isFile()) throw new Error(`${shown} isn't a regular file, so ${tool} can't change it`)
  if (info.nlink > 1) {
    throw new Error(
      `${shown} is one of ${info.nlink} hard links to the same file, and the rest may lie outside the workspace, so ${tool} won't change it`,
    )
  }
  if (info.size > CHANGE_LIMIT_BYTES) {
    throw new Error(
      `${shown} is ${info.size} bytes, over the ${CHANGE_LIMIT_BYTES} that write_file and edit_file read to show a change as a diff; change it with run_command instead`,
    )
  }
  const handle = await open(real)
  try {
    if (await is_binary(handle)) {
      throw new Error(`${shown} is a binary file (it has a NUL byte in its first 8 KB), so ${tool} won't change it`)
    }
    // The binary check reads at an explicit position, which leaves the
    // handle's own position at the top, where readFile starts.
    const bytes = await handle.readFile()
    if (!isUtf8(bytes)) throw new Error(`${shown} isn't UTF-8 text, so ${tool} won't change it`)
    return bytes.toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Write a change's new text where it lands, creating the directories it
 * needs first. A turn cancelled while the change was worked out stops here,
 * before anything is written. A new file is created exclusively, so a file or
 * a symlink that appeared at its path since then stops the write instead of
 * taking it.
 */
export async function apply_change(change: FileChange, abort: AbortSignal): Promise<void> {
  abort.throwIfAborted()
  await mkdir(dirname(change.real), { recursive: true })
  await writeFile(change.real, change.new_text, change.old_text === null ? { flag: 'wx' } : {})
}

/**
 * Leave a change that landed in the session's preview store, for the card
 * of the call that made it to show as a diff.
 */
export function record_change(
  session: AcpSession,
  tool_call_id: string,
  change: ShownChange,
): void {
  record_preview(session, tool_call_id, {
    kind: 'change',
    path: change.path,
    old_text: change.old_text,
    new_text: change.new_text,
    line: change.line,
  })
}

/**
 * The change a `write_file` call would make, worked out without writing: its
 * path checked against the session's roots, the text it would replace, and
 * the content that replaces it.
 */
export async function write_file_change(session: AcpSession, input: unknown): Promise<FileChange> {
  const request = write_request(input)
  const target = await contain(session, request.path)
  const old_text = await current_text(target.real, request.path, 'write_file')
  return { ...target, old_text, new_text: request.content }
}

/**
 * The `write_file` tool for one session: a file inside its workspace,
 * created or replaced whole. The model reads back a line saying which, since
 * it already has the text it sent.
 */
export function write_file_tool(session: AcpSession): Tool {
  return {
    name: 'write_file',
    description:
      'Write a text file in the workspace: create it, along with any directories it needs, or replace everything it holds. ' +
      "content is the file's whole text; to change part of a file, use edit_file. " +
      'The path is absolute or relative to the workspace root.',
    input_schema: json_schema_to_standard({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to write, absolute or relative to the workspace root' },
        content: { type: 'string', description: "The file's whole text" },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    }),
    execute: async (input, ctx) => {
      const change = await write_file_change(session, input)
      await apply_change(change, ctx.abort)
      record_change(session, ctx.tool_call_id, change)
      return `${change.old_text === null ? 'created' : 'overwrote'} ${shown_path(session, change.path)}`
    },
  }
}
