/**
 * presentation: how a workspace tool's call looks in the client, matching
 * what Zed's Claude Agent sends for its own tools.
 *
 * Each card gets the kind that picks its icon, a title that reads like the
 * call (`Read src/a.ts (1 - 40)`, `grep "todo" src`, the command line) with
 * its paths relative to `cwd`, and the places it touches as locations, whose
 * lines count from 1 as Claude Agent's do. A write's or an edit's card shows
 * its diff once the call lands, a read's, a listing's, or a search's shows
 * the text the model read in a code block, and a command's shows what it
 * printed: in a terminal when the client advertises Zed's terminal extension
 * (`_meta.terminal_output`), and as a `console` code block otherwise.
 *
 * It's keyed by tool name, since nothing ACP-specific may reach the engine's
 * `Tool` type, and it does no I/O: the file reads behind a diff happen in
 * the tools, which leave each call's preview in the session's store for its
 * card to take when the call's result arrives.
 */

import { resolve } from 'node:path'
import type { SessionUpdate, ToolCall, ToolCallContent, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '#engine'
import { as_record } from '#schema'
import { shown_path } from './tools/containment.js'
import { take_preview } from './tools/previews.js'
import type { ChangePreview, CommandPreview, ToolPreview } from './tools/previews.js'
import type { AcpSession } from './types.js'

type ToolResultChunk = Extract<StreamChunk, { kind: 'tool_result' }>

/** An update to a card the client already shows. */
export type CardUpdate = Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }>

/** What a call's input says about its card: its title, and the places it touches. */
type Described = {
  readonly title: string
  readonly locations?: ToolCallLocation[]
}

/** How a command ended, as its terminal shows it. */
type Ran = Pick<CommandPreview, 'output' | 'exit_code' | 'signal'>

/**
 * How one workspace tool's cards look: the kind that picks the icon, what a
 * call's input says about it, and what its card shows once the call
 * succeeds: the change it made, what the command printed, or the text the
 * model read.
 */
type Presenter = {
  readonly kind: ToolKind
  readonly describe: (fields: Record<string, unknown>, session: AcpSession) => Described | undefined
  readonly shows?: 'change' | 'command' | 'text'
}

/**
 * A path the call names, made absolute under the client's `cwd`, which is
 * how a location and a diff carry it.
 */
function absolute(session: AcpSession, path: string): string {
  return resolve(session.cwd, path)
}

/**
 * A path as a title shows it: relative to `cwd` when it's under it, and
 * absolute otherwise, the way the tools show paths to the model.
 */
function shown(session: AcpSession, path: string): string {
  return shown_path(session, absolute(session, path))
}

/**
 * The lines a read covers, as its title says them: a range when the call
 * sets a limit, where it starts when it sets only an offset, and nothing
 * when it reads from the top.
 */
function read_range(first: number, offset: unknown, limit: unknown): string {
  if (typeof limit === 'number') return ` (${first} - ${first + limit - 1})`
  if (typeof offset === 'number') return ` (from line ${offset})`
  return ''
}

/**
 * A `read_file` card: `Read <path>` with the lines it covers, pointing at
 * the line the read starts on.
 */
function describe_read({ path, offset, limit }: Record<string, unknown>, session: AcpSession): Described | undefined {
  if (typeof path !== 'string') return undefined
  const first = typeof offset === 'number' ? offset : 1
  return {
    title: `Read ${shown(session, path)}${read_range(first, offset, limit)}`,
    locations: [{ path: absolute(session, path), line: first }],
  }
}

/**
 * A `write_file` or `edit_file` card: the verb and the path, pointing at
 * the file. The line an edit lands on comes with its preview, once the
 * edit has found it.
 */
function describe_change(verb: string): Presenter['describe'] {
  return ({ path }, session) =>
    typeof path === 'string'
      ? { title: `${verb} ${shown(session, path)}`, locations: [{ path: absolute(session, path) }] }
      : undefined
}

/**
 * A `list_files` card: `Find` with the directory and the pattern in code
 * spans, each when the call names it.
 */
function describe_find({ pattern, path }: Record<string, unknown>, session: AcpSession): Described {
  const parts = ['Find']
  if (typeof path === 'string') parts.push(`\`${shown(session, path)}\``)
  if (typeof pattern === 'string') parts.push(`\`${pattern}\``)
  return { title: parts.join(' ') }
}

/**
 * A `search` card, titled the way the grep command line that does the same
 * search reads.
 */
function describe_grep({ pattern, path, glob }: Record<string, unknown>, session: AcpSession): Described {
  const parts = ['grep']
  if (typeof glob === 'string') parts.push(`--include="${glob}"`)
  if (typeof pattern === 'string') parts.push(`"${pattern}"`)
  if (typeof path === 'string') parts.push(shown(session, path))
  return { title: parts.join(' ') }
}

/**
 * A `run_command` card, titled with the command line itself.
 */
function describe_command({ command }: Record<string, unknown>): Described | undefined {
  return typeof command === 'string' ? { title: command } : undefined
}

/**
 * The workspace tools by name. The key takes `undefined` too, so a card
 * whose opening the mapper never saw simply finds nothing.
 */
const PRESENTERS = new Map<string | undefined, Presenter>([
  ['read_file', { kind: 'read', describe: describe_read, shows: 'text' }],
  ['list_files', { kind: 'search', describe: describe_find, shows: 'text' }],
  ['search', { kind: 'search', describe: describe_grep, shows: 'text' }],
  ['write_file', { kind: 'edit', describe: describe_change('Write'), shows: 'change' }],
  ['edit_file', { kind: 'edit', describe: describe_change('Edit'), shows: 'change' }],
  ['run_command', { kind: 'execute', describe: describe_command, shows: 'command' }],
])

/**
 * Whether the client draws a command's output in a terminal from Zed's
 * `_meta` extension, which it says in `initialize`.
 */
function renders_terminals(session: AcpSession): boolean {
  const { _meta: meta } = session.client_capabilities
  return meta?.['terminal_output'] === true
}

/**
 * The terminal a card shows, under the card's own id, as Claude Agent names
 * its terminals.
 */
function terminal(card: string): ToolCallContent {
  return { type: 'terminal', terminalId: card }
}

/**
 * What a workspace tool's card opens with: its kind, and for a command in a
 * client that draws terminals, the terminal its output will land in.
 */
export function opening_fields(session: AcpSession | undefined, name: string, card: string): Partial<ToolCall> {
  const presenter = PRESENTERS.get(name)
  if (session === undefined || presenter === undefined) return {}
  if (presenter.shows !== 'command' || !renders_terminals(session)) return { kind: presenter.kind }
  return { kind: presenter.kind, content: [terminal(card)], _meta: { terminal_info: { terminal_id: card } } }
}

/**
 * What a workspace tool call's complete input adds to its card: its title
 * and locations. An input that lacks what they need leaves the card as it
 * opened.
 */
export function input_fields(session: AcpSession | undefined, name: string | undefined, input: unknown): Partial<CardUpdate> {
  const presenter = PRESENTERS.get(name)
  if (session === undefined || presenter === undefined) return {}
  return presenter.describe(as_record(input) ?? {}, session) ?? {}
}

/**
 * A file change as a diff, which a client shows as the file's hunks.
 */
function diff_of(change: ChangePreview): ToolCallContent {
  return { type: 'diff', path: change.path, oldText: change.old_text, newText: change.new_text }
}

/**
 * Close a write's or an edit's card with the change it made, and for an
 * edit, the line its first match starts on. The closing update replaces the
 * card's content, so it carries the diff again rather than dropping one the
 * card already shows. A call that failed, or left no change behind, closes
 * as it stands.
 */
function close_change(closing: CardUpdate, preview: ToolPreview | undefined): CardUpdate {
  if (preview?.kind !== 'change') return closing
  return {
    ...closing,
    content: [diff_of(preview)],
    ...(preview.line === undefined ? {} : { locations: [{ path: preview.path, line: preview.line }] }),
  }
}

/**
 * Text in a code block under the `info` string, its fence longer than any
 * run of backticks that opens one of its lines, so nothing in the text can
 * close the block early.
 */
function code_block(text: string, info: string): ToolCallContent {
  const longest = Math.max(2, ...Array.from(text.matchAll(/^`+/gm), ([run]) => run.length))
  const fence = '`'.repeat(longest + 1)
  return { type: 'content', content: { type: 'text', text: `${fence}${info}\n${text}\n${fence}` } }
}

/**
 * Close a read's, a listing's, or a search's card with the text the model
 * read. A listing or a search result goes in a code block too, since a
 * matching line can hold markdown that the client would otherwise render.
 * A failed call keeps its error text.
 */
function close_text(closing: CardUpdate, chunk: ToolResultChunk): CardUpdate {
  if (chunk.error !== undefined) return closing
  return { ...closing, content: [code_block(String(chunk.output), '')] }
}

/**
 * How a command's terminal ends: what it printed and how it exited, or, for
 * a call that failed or left nothing behind, the error text and no exit
 * code.
 */
function ran(chunk: ToolResultChunk, preview: ToolPreview | undefined): Ran {
  if (preview?.kind === 'command') return preview
  return { output: chunk.error?.message ?? '', exit_code: null, signal: null }
}

/**
 * Close a command's card. A client that draws terminals gets the output on
 * the terminal the card opened with, then the exit and the status, as
 * Claude Agent sends them. Any other client gets what the model read, its
 * exit code included, in a `console` block; a failed call keeps its error
 * text.
 */
function close_command(
  session: AcpSession,
  card: string,
  chunk: ToolResultChunk,
  closing: CardUpdate,
  preview: ToolPreview | undefined,
): SessionUpdate[] {
  if (!renders_terminals(session)) {
    if (chunk.error !== undefined) return [closing]
    return [{ ...closing, content: [code_block(String(chunk.output), 'console')] }]
  }
  const { output, exit_code, signal } = ran(chunk, preview)
  return [
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: card,
      _meta: { terminal_output: { terminal_id: card, data: output } },
    },
    {
      ...closing,
      content: [terminal(card)],
      _meta: { terminal_exit: { terminal_id: card, exit_code, signal } },
    },
  ]
}

/**
 * The updates that close a tool call's card, starting from the plain
 * `closing` update. A read, a listing, or a search leaves no preview, so its
 * card takes nothing from the session's store. A successful call of a tool
 * that leaves a preview takes it from the store whatever the card then does
 * with it, which keeps each raw id's queue in step with its results.
 */
export function closing_updates(
  session: AcpSession | undefined,
  name: string | undefined,
  card: string,
  chunk: ToolResultChunk,
  closing: CardUpdate,
): SessionUpdate[] {
  const shows = PRESENTERS.get(name)?.shows
  if (session === undefined || shows === undefined) return [closing]
  if (shows === 'text') return [close_text(closing, chunk)]
  const preview = chunk.error === undefined ? take_preview(session, chunk.id) : undefined
  if (shows === 'change') return [close_change(closing, preview)]
  return close_command(session, card, chunk, closing, preview)
}
