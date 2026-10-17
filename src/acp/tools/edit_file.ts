/**
 * edit_file: replace an exact match in a text file in the workspace.
 *
 * The match has to be exact and, unless the call sets `replace_all`, the only
 * one, so the model names enough of the file to say which place it means. A
 * looser match could change a place it never looked at. The change is worked
 * out first, the way `write_file`'s is, as the whole file before and after,
 * with the line where the first match starts for the client to point at.
 */

import type { Tool } from '#engine'
import { as_record, json_schema_to_standard } from '#schema'
import type { AcpSession } from '../types.js'
import { contain, shown_path } from './containment.js'
import { apply_change, current_text, record_change } from './write_file.js'
import type { FileChange } from './write_file.js'

/**
 * A change `edit_file` would make. The file exists, so `old_text` is always
 * its text. `line` is where the first match starts, counting from 1, and
 * `matches` is how many places the edit replaces.
 */
export type EditChange = FileChange & {
  readonly old_text: string
  readonly line: number
  readonly matches: number
}

/** One edit as the model asked for it. */
type EditRequest = {
  readonly path: string
  readonly old_text: string
  readonly new_text: string
  readonly replace_all: boolean
}

/**
 * Read the call's path, texts, and `replace_all` out of its input, refusing
 * an `old_text` that's empty, which matches everywhere, or the same as
 * `new_text`, which changes nothing.
 */
function edit_request(input: unknown): EditRequest {
  const fields: Record<string, unknown> = as_record(input) ?? {}
  const { path, old_text, new_text, replace_all = false } = fields
  if (
    typeof path !== 'string' ||
    typeof old_text !== 'string' ||
    typeof new_text !== 'string' ||
    typeof replace_all !== 'boolean'
  ) {
    throw new Error('edit_file needs path, old_text, and new_text as strings, and takes replace_all as true or false')
  }
  if (old_text === '') throw new Error("old_text is empty, so there's nothing to find; write_file writes a whole file")
  if (old_text === new_text) throw new Error('old_text and new_text are the same, so the edit would change nothing')
  return { path, old_text, new_text, replace_all }
}

/**
 * The change an `edit_file` call would make, worked out without writing: the
 * file's whole text before, and after `old_text` is replaced. It fails when
 * `old_text` isn't there, or is there more than once and the call doesn't set
 * `replace_all`.
 */
export async function edit_file_change(session: AcpSession, input: unknown): Promise<EditChange> {
  const request = edit_request(input)
  const target = await contain(session, request.path)
  const text = await current_text(target.real, request.path, 'edit_file')
  if (text === null) throw new Error(`${request.path} doesn't exist; write_file creates a file`)
  // Splitting on the match, where String.replace would read its replacement
  // as a pattern, keeps a `$&` or `$$` in new_text as the model wrote it.
  const pieces = text.split(request.old_text)
  const matches = pieces.length - 1
  if (matches === 0) {
    throw new Error(
      `old_text doesn't appear in ${request.path}; it has to match the file exactly, whitespace included, so read the lines again and copy them without their numbers`,
    )
  }
  if (matches > 1 && !request.replace_all) {
    throw new Error(
      `old_text appears ${matches} times in ${request.path}; include more of the lines around it so it matches once, or set replace_all to replace every one`,
    )
  }
  const before = text.slice(0, text.indexOf(request.old_text))
  return {
    ...target,
    old_text: text,
    new_text: pieces.join(request.new_text),
    line: before.split('\n').length,
    matches,
  }
}

/**
 * The `edit_file` tool for one session: an exact match replaced in a file
 * inside its workspace. The model reads back where the edit landed rather
 * than the file again.
 */
export function edit_file_tool(session: AcpSession): Tool {
  return {
    name: 'edit_file',
    description:
      'Edit a text file in the workspace by replacing old_text with new_text. ' +
      'old_text has to match the file exactly, whitespace and line breaks included, ' +
      'and appear in it once, unless replace_all is set to replace every match. ' +
      'Copy it from read_file without the line number and tab that read_file puts before each line. ' +
      'The path is absolute or relative to the workspace root.',
    input_schema: json_schema_to_standard({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to edit, absolute or relative to the workspace root' },
        old_text: { type: 'string', minLength: 1, description: 'The exact text to replace' },
        new_text: { type: 'string', description: 'The text to put in its place' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every match of old_text, rather than exactly one; default: false',
        },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    }),
    execute: async (input, ctx) => {
      const change = await edit_file_change(session, input)
      await apply_change(change, ctx.abort)
      record_change(session, ctx.tool_call_id, change)
      const shown = shown_path(session, change.path)
      return change.matches === 1
        ? `edited ${shown} at line ${change.line}`
        : `edited ${shown} in ${change.matches} places, the first at line ${change.line}`
    },
  }
}
