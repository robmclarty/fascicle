/**
 * transcript: one turn as the client saw it, kept so `session/load` can show
 * the thread again.
 *
 * A turn's record is its prompt as `user_message_chunk` updates, then every
 * update the turn sent. A reply streams as one chunk per token, so adjacent
 * text chunks of one kind are joined into one, which keeps a turn's record
 * to a few entries for each message. Tool calls and their updates stay as
 * they were sent, so an edit's diff and a command's output replay as they
 * appeared. What tells the client about the session instead of adding to the
 * thread (its title, its usage, a notice) stays out, since a load sends the
 * title and the usage as they stand now.
 */

import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'

/** A turn's record as it builds up. */
export type Transcript = {
  /** Adds an update the client was sent. */
  readonly note: (update: SessionUpdate) => void
  /** The record so far. */
  readonly updates: () => SessionUpdate[]
}

type TextChunk = Extract<SessionUpdate, { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk' }>

/** The updates about the session, which a turn's record leaves out. */
const ABOUT_THE_SESSION: ReadonlySet<string> = new Set(['session_info_update', 'usage_update', 'notice'])

/**
 * Whether `update` carries a run of text, which is what gets joined.
 */
function is_text_chunk(update: SessionUpdate): update is TextChunk {
  const kind = update.sessionUpdate
  if (kind !== 'user_message_chunk' && kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk') return false
  return update.content.type === 'text'
}

/**
 * Everything about a text chunk but its text, as one string. Two chunks join
 * only when this matches, so a chunk that belongs to another message stays
 * its own.
 */
function rest_of(chunk: TextChunk): string {
  return JSON.stringify({ ...chunk, content: { ...chunk.content, text: '' } })
}

/**
 * `first` with the text of `second` after its own.
 */
function joined(first: TextChunk, second: TextChunk): SessionUpdate {
  if (first.content.type !== 'text' || second.content.type !== 'text') return first
  return { ...first, content: { ...first.content, text: first.content.text + second.content.text } }
}

/**
 * Add `update` to `updates`, joined onto the last one when both are text
 * chunks that differ only in their text.
 */
function append(updates: SessionUpdate[], update: SessionUpdate): void {
  const last = updates.at(-1)
  if (last !== undefined && is_text_chunk(last) && is_text_chunk(update) && rest_of(last) === rest_of(update)) {
    updates[updates.length - 1] = joined(last, update)
    return
  }
  updates.push(structuredClone(update))
}

/**
 * Start a turn's record with the prompt the client sent, one
 * `user_message_chunk` for each block, with adjacent text joined.
 */
export function create_transcript(prompt: ReadonlyArray<ContentBlock>): Transcript {
  const updates: SessionUpdate[] = []
  for (const content of prompt) append(updates, { sessionUpdate: 'user_message_chunk', content })
  return {
    note: (update) => {
      if (!ABOUT_THE_SESSION.has(update.sessionUpdate)) append(updates, update)
    },
    updates: () => updates,
  }
}
