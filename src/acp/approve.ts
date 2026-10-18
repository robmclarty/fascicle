/**
 * approve: ask the client before a workspace tool edits a file or runs a
 * command, through `session/request_permission`.
 *
 * The request shows the card the client already draws for the call, and
 * for an edit, the change worked out on disk first, so the user approves
 * the diff itself. It offers Allow, Reject, and an "always" that lives in
 * memory for the session. For an edit, "always" switches the session to
 * Accept edits, as Claude Agent's does, and tells the client both ways so
 * its mode picker follows. For a command, it covers that exact command
 * line and nothing else, since one flag can turn a listing into a delete
 * (`find . -name '*.ts'` and `find . -delete`). A command with shell
 * control syntax is never covered and never offered one, since anything
 * can follow a `;` or a `|`.
 *
 * Only the session's own workspace tools get the diff and the "always",
 * known by the input their `needs_approval` marked rather than by name. A
 * tool of a flow's own or an MCP tool that shares a name gets the plain
 * request, and no grant covers it.
 *
 * A permission check that fails open isn't a check, so anything short of
 * an allow denies the call: a rejection, a `cancelled` outcome, an option
 * the request never offered, and a request that fails for any reason.
 *
 * The engine asks with its raw call id, which can repeat inside a turn,
 * and the turn's consumer can still be sending earlier updates when it
 * asks. So the request waits until the consumer has sent everything the
 * run had recorded by then, the card's opening included, and points at the
 * latest card the client was sent for that raw id. The consumer never
 * waits on an approval, so the wait can't deadlock, and the turn's abort
 * ends it.
 */

import { randomUUID } from 'node:crypto'
import type {
  PermissionOption,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk'
import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import type { ToolApprovalRequest } from '#engine'
import { as_record } from '#schema'
import { asks_before } from './modes.js'
import type { GatedAction, SessionModes } from './modes.js'
import { input_fields, opening_fields } from './presentation.js'
import { edit_file_change } from './tools/edit_file.js'
import { write_file_change } from './tools/write_file.js'
import type { ShownChange } from './tools/write_file.js'
import type { AcpSession } from './types.js'
import { is_workspace_call } from './workspace_tools.js'

/**
 * What a session's turn tells its approvals: how far the turn's consumer
 * has got, and which card each raw call id opened last.
 *
 * A run that outran the client so far that it dropped events never lets
 * the consumer catch up, so an approval it asks for waits until the turn
 * is cancelled. Only a client that has stopped reading gets that far
 * behind, and it wouldn't answer the request either.
 */
export type CardSync = {
  /**
   * Start a turn, forgetting the last one. Returns the logger the turn's
   * run records through, which counts every event `run.stream` queues and
   * passes each one on to `inner`.
   */
  readonly start: (inner: TrajectoryLogger | undefined) => TrajectoryLogger
  /** Note that the consumer has sent every update one event maps to. */
  readonly sent: (event: TrajectoryEvent, updates: ReadonlyArray<SessionUpdate>) => void
  /** Settle once the consumer has sent every event the run had recorded by now. */
  readonly caught_up: () => Promise<void>
  /** The id of the latest card the client was sent for a raw call id. */
  readonly card_for: (raw_id: string) => string | undefined
}

/** One turn's count of the events its run recorded and its consumer sent. */
type TurnProgress = {
  recorded: number
  sent: number
  /** Settles at the consumer's next event, then gives way to a fresh one. */
  moved: PromiseWithResolvers<void>
  readonly cards: Map<string, string>
}

/**
 * Asks the client to approve one tool call, and withdraws the request
 * when `cancel` fires.
 */
export type PermissionAsker = (
  request: RequestPermissionRequest,
  cancel: AbortSignal,
) => Promise<RequestPermissionResponse>

/** What a session's approvals need beside the session itself. */
export type ApproverDeps = {
  readonly modes: SessionModes
  readonly cards: CardSync
  readonly ask: PermissionAsker
}

/** Answers the engine's approval requests for the calls in one session. */
export type SessionApprover = (session: AcpSession, request: ToolApprovalRequest) => Promise<boolean>

/**
 * What a workspace tool that asks does, and for a write or an edit, how
 * to work out its change without making it. A gate goes by name, but only
 * a call the session's own workspace tool marked ever reaches one.
 */
type Gate = {
  readonly action: GatedAction
  readonly change?: (session: AcpSession, input: unknown) => Promise<ShownChange>
}

const GATES: ReadonlyMap<string, Gate> = new Map<string, Gate>([
  ['write_file', { action: 'edit', change: write_file_change }],
  ['edit_file', { action: 'edit', change: edit_file_change }],
  ['run_command', { action: 'command' }],
])

/**
 * Shell syntax that runs, chains, or redirects something past the
 * command's own program: `;`, `&`, `|`, `>`, `<`, a backtick, `$(`, and a
 * newline.
 */
const CONTROL_SYNTAX = /[;&|<>`\n]|\$\(/

/** The "always" an approval offers, and what choosing it grants. */
type Always = {
  readonly name: string
  readonly grant: () => Promise<void>
}

const ALLOW_ONCE: PermissionOption = { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }
const REJECT_ONCE: PermissionOption = { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }

/**
 * A fresh count for a turn that has recorded and sent nothing yet.
 */
function fresh_progress(): TurnProgress {
  return { recorded: 0, sent: 0, moved: Promise.withResolvers(), cards: new Map() }
}

/**
 * `inner`, or nothing, with `count` called after each call that queues an
 * event. Without an inner logger, a span gets an id of its own, as the
 * runner's default logger gives one.
 */
function counting_logger(inner: TrajectoryLogger | undefined, count: () => void): TrajectoryLogger {
  return {
    record: (event) => {
      inner?.record(event)
      count()
    },
    start_span: (name, meta) => {
      const id = inner?.start_span(name, meta) ?? `${name}:${randomUUID()}`
      count()
      return id
    },
    end_span: (id, meta) => {
      inner?.end_span(id, meta)
      count()
    },
  }
}

/**
 * The raw id of the call a `tool_call_start` chunk opens, or `undefined`
 * for any other event.
 */
function started_call(event: TrajectoryEvent): string | undefined {
  if (event.kind !== 'model_chunk') return undefined
  const chunk = as_record(event['chunk'])
  // Stryker disable next-line ConditionalExpression: a non-string id would land under a key no string lookup finds, so the check only narrows the type.
  return chunk?.['kind'] === 'tool_call_start' && typeof chunk['id'] === 'string' ? chunk['id'] : undefined
}

/**
 * Whether an update opens a card.
 */
function opens_card(update: SessionUpdate): update is Extract<SessionUpdate, { sessionUpdate: 'tool_call' }> {
  return update.sessionUpdate === 'tool_call'
}

/**
 * Create the sync between a session's turns and its approvals. Turns in a
 * session never overlap, so one sync serves them all, a turn at a time.
 */
export function create_card_sync(): CardSync {
  let turn = fresh_progress()
  return {
    start: (inner) => {
      const started = fresh_progress()
      turn = started
      return counting_logger(inner, () => {
        started.recorded += 1
      })
    },
    sent: (event, updates) => {
      const raw_id = started_call(event)
      const card = updates.find(opens_card)
      // Stryker disable next-line ConditionalExpression: a card noted under no raw id sits where no lookup asks, so the check only narrows the type.
      if (raw_id !== undefined && card !== undefined) turn.cards.set(raw_id, card.toolCallId)
      turn.sent += 1
      turn.moved.resolve()
      turn.moved = Promise.withResolvers()
    },
    caught_up: async () => {
      const waiting = turn
      const target = waiting.recorded
      while (waiting.sent < target) await waiting.moved.promise
    },
    card_for: (raw_id) => turn.cards.get(raw_id),
  }
}

/**
 * What an "always" grant for a command covers: the command line itself,
 * with the whitespace at its ends trimmed and everything between compared
 * exactly, because `rm "a  b"` and `rm "a b"` name different files. A
 * command with shell control syntax has none, so no grant ever covers it,
 * and neither does one that isn't a string or is only whitespace.
 */
export function command_key(input: unknown): string | undefined {
  const command = as_record(input)?.['command']
  if (typeof command !== 'string' || CONTROL_SYNTAX.test(command)) return undefined
  const key = command.trim()
  return key === '' ? undefined : key
}

/**
 * The message a failure carries, whatever was thrown.
 */
export function message_of(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Start `work` and settle with it, or reject with the abort's reason as
 * soon as `abort` fires, so a turn's cancel never waits on the client. A
 * turn already cancelled starts nothing, so no request goes out for it.
 */
async function unless_aborted<T>(abort: AbortSignal, work: () => Promise<T>): Promise<T> {
  abort.throwIfAborted()
  const { promise: aborted, reject } = Promise.withResolvers<never>()
  const on_abort = (): void => {
    reject(abort.reason)
  }
  abort.addEventListener('abort', on_abort)
  try {
    return await Promise.race([work(), aborted])
  } finally {
    // The turn's signal outlives every approval it asks for.
    abort.removeEventListener('abort', on_abort)
  }
}

/**
 * What a change adds to the request's card: its diff, and for an edit,
 * the line its first match starts on. A change that can't be worked out
 * shows why instead, which is what the call will fail with if it's
 * allowed, so the user isn't asked to approve a change they can't see.
 */
async function change_fields(
  change: NonNullable<Gate['change']>,
  session: AcpSession,
  input: unknown,
): Promise<Partial<ToolCallUpdate>> {
  try {
    const { path, old_text, new_text, line } = await change(session, input)
    return {
      content: [{ type: 'diff', path, oldText: old_text, newText: new_text }],
      ...(line === undefined ? {} : { locations: [{ path, line }] }),
    }
  } catch (err: unknown) {
    return { content: [{ type: 'content', content: { type: 'text', text: message_of(err) } }] }
  }
}

/**
 * The card a request shows: the one the client already draws for the call
 * under `card`, as its tool's presentation describes it, with the change
 * for a write or an edit.
 */
async function permission_card(
  session: AcpSession,
  request: ToolApprovalRequest,
  card: string,
  gate: Gate | undefined,
): Promise<ToolCallUpdate> {
  const { tool_name: name, input } = request
  const fields: ToolCallUpdate = {
    toolCallId: card,
    title: name,
    kind: opening_fields(session, name, card).kind ?? 'other',
    rawInput: input,
    ...input_fields(session, name, input),
  }
  if (gate?.change === undefined) return fields
  return { ...fields, ...(await change_fields(gate.change, session, input)) }
}

/**
 * Whether the user's answer allows the call, granting the "always" first
 * when that's what they chose. Only an option the request offered counts.
 */
async function allowed(outcome: RequestPermissionOutcome, always: Always | undefined): Promise<boolean> {
  if (outcome.outcome !== 'selected') return false
  if (outcome.optionId === ALLOW_ONCE.optionId) return true
  if (outcome.optionId !== 'allow_always' || always === undefined) return false
  await always.grant()
  return true
}

/**
 * Say on stderr that a permission request failed, since the call was
 * refused without the user ever seeing it.
 */
function warn_failed(tool_name: string, err: unknown): void {
  process.stderr.write(
    `fascicle/acp: asking the client to approve ${tool_name} failed (${message_of(err)}), so the call was refused; check that the client answers session/request_permission\n`,
  )
}

/**
 * The "always" a call is offered: Accept edits for an edit, and a grant of
 * its key for a command that has one. Any other call gets none. Choosing
 * Accept edits leaves a session that has moved past Manual since the call
 * asked where it is.
 */
function always_for(
  gate: Gate | undefined,
  key: string | undefined,
  modes: SessionModes,
  granted: Set<string>,
): Always | undefined {
  if (gate?.action === 'edit') {
    return {
      name: 'Allow all edits this session',
      grant: async () => {
        if (asks_before(modes.current(), 'edit')) await modes.switch_to('accept_edits')
      },
    }
  }
  if (key === undefined) return undefined
  return {
    name: `Always allow \`${key}\` this session`,
    grant: async () => {
      granted.add(key)
    },
  }
}

/**
 * The options a request offers. Allow is always among them, since some
 * hosts answer every request on their own by choosing `allow_once`.
 */
function options_for(always: Always | undefined): PermissionOption[] {
  if (always === undefined) return [ALLOW_ONCE, REJECT_ONCE]
  return [ALLOW_ONCE, { optionId: 'allow_always', name: always.name, kind: 'allow_always' }, REJECT_ONCE]
}

/**
 * Create the approvals for one session's calls, holding its commands'
 * "always" grants for the life of the session.
 */
export function session_approver({ modes, cards, ask }: ApproverDeps): SessionApprover {
  const granted = new Set<string>()
  return async (session, request) => {
    const gate = is_workspace_call(session, request.input) ? GATES.get(request.tool_name) : undefined
    const key = gate?.action === 'command' ? command_key(request.input) : undefined
    // Stryker disable next-line ConditionalExpression: only keys are ever granted, so has() answers false for a missing key either way; the check narrows the type.
    if (key !== undefined && granted.has(key)) return true
    const always = always_for(gate, key, modes, granted)
    const options = options_for(always)
    try {
      await unless_aborted(request.abort, cards.caught_up)
      const card = cards.card_for(request.tool_call_id) ?? randomUUID()
      const toolCall = await permission_card(session, request, card, gate)
      const answer = await unless_aborted(request.abort, () =>
        ask({ sessionId: session.id, toolCall, options }, request.abort),
      )
      return await allowed(answer.outcome, always)
    } catch (err: unknown) {
      if (!request.abort.aborted) warn_failed(request.tool_name, err)
      return false
    }
  }
}
