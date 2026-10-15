/**
 * The preview store: what each workspace tool call changed or ran, kept for
 * the client's card that shows it.
 *
 * A write's card shows its diff and a command's shows its output and exit
 * code, but the model reads back a single line, so the call's result can't
 * carry them. Each tool leaves its call's preview here once the call
 * succeeds, under the engine's raw call id, and `to_session_updates` takes
 * it when that call's result arrives. The file reads behind a diff happen
 * in the tool, before it writes, so the mapper itself stays free of I/O.
 *
 * Raw ids repeat across model calls (Ollama numbers its calls afresh on
 * each one), and the turn's consumer can fall behind the engine, so each id
 * holds a queue, taken oldest first. The engine runs a turn's calls one
 * after another, which keeps each queue in the order its results arrive.
 * Only a call that succeeded leaves a preview, and only a successful result
 * takes one, so a call refused before it ran can't take a later call's.
 *
 * The store belongs to the session and is keyed by the session object, so
 * `AcpSession` carries nothing for it. Each turn starts it empty, so what a
 * cancelled turn left behind never reaches the next.
 */

import type { AcpSession } from '../types.js'

/**
 * A file change that landed: the path in the client's terms, the text
 * before (`null` for a new file) and after, and for an edit, the line where
 * its first match starts, counting from 1 (a write has none).
 */
export type ChangePreview = {
  readonly kind: 'change'
  readonly path: string
  readonly old_text: string | null
  readonly new_text: string
  readonly line: number | undefined
}

/**
 * A command that ran to its end: what it printed, and its exit code or the
 * signal that ended it.
 */
export type CommandPreview = {
  readonly kind: 'command'
  readonly output: string
  readonly exit_code: number | null
  readonly signal: string | null
}

export type ToolPreview = ChangePreview | CommandPreview

const stores = new WeakMap<AcpSession, Map<string, ToolPreview[]>>()

/**
 * The session's store, made empty the first time it's asked for.
 */
function store_of(session: AcpSession): Map<string, ToolPreview[]> {
  const store = stores.get(session) ?? new Map<string, ToolPreview[]>()
  stores.set(session, store)
  return store
}

/**
 * Empty the session's store as a turn starts.
 */
export function reset_previews(session: AcpSession): void {
  stores.set(session, new Map())
}

/**
 * Leave a call's preview at the back of its raw id's queue.
 */
export function record_preview(session: AcpSession, tool_call_id: string, preview: ToolPreview): void {
  const store = store_of(session)
  store.set(tool_call_id, [...(store.get(tool_call_id) ?? []), preview])
}

/**
 * Take the oldest preview waiting under a raw id, or `undefined` when none
 * is.
 */
export function take_preview(session: AcpSession, tool_call_id: string): ToolPreview | undefined {
  return store_of(session).get(tool_call_id)?.shift()
}
