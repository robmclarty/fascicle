/**
 * One ACP prompt turn: run the session's flow through `run.stream` and send
 * what it produces to the client as session updates.
 *
 * The turn holds three rules the protocol leaves to the agent. A cancel
 * (`session/cancel`, the request's own `$/cancel_request`, a disconnect, or
 * the config's `abort`) stops the sending at once, then waits for the run to
 * settle and answers `cancelled`, even when the flow ignored the abort and
 * finished. A turn that sent no message text sends `to_text(output)` as its
 * reply. And the history records what the client was actually sent, a
 * cancelled turn included, so it matches the thread the user sees.
 */

import type { ContentBlock, PromptResponse, SessionUpdate } from '@agentclientprotocol/sdk'
import { aborted_error, run } from '#core'
import type { Step, TrajectoryEvent } from '#core'
import { create_acp_mapper_state, to_session_updates } from './to_session_updates.js'
import { reset_previews } from './tools/previews.js'
import type { AcpHistoryEntry, AcpSession, AcpTurn, ServeAcpConfig } from './types.js'

/**
 * A session's latest turn, finished or not. Cancelling a finished turn does
 * nothing and waiting on it returns at once, so the record never needs
 * clearing.
 */
type TurnHandle = {
  readonly cancel: AbortController
  readonly settled: Promise<void>
}

/** A session between turns: its flow, its history, and its latest turn. */
export type SessionRecord<i, o> = {
  readonly session: AcpSession
  readonly flow: Step<i, o>
  readonly history: AcpHistoryEntry[]
  last_turn: TurnHandle | null
}

export type SendUpdate = (update: SessionUpdate) => Promise<void>

type Reply = { sent: boolean; text: string }

type Settled<o> = { readonly ok: true; readonly output: o } | { readonly ok: false; readonly error: unknown }

/**
 * Join a prompt's blocks into the text a flow reads. Text blocks join as the
 * client split them, and a resource link or an embedded resource reads as
 * its URI where it sat. Each embedded resource's text follows the prompt in
 * a `<context>` block naming that URI, the form Claude Agent uses, so a file
 * the user @-mentioned reaches the model without splitting the sentence that
 * mentions it. Image and audio blocks stay in `turn.prompt` only, since the
 * agent advertises neither.
 */
function turn_text(prompt: ReadonlyArray<ContentBlock>): string {
  const inline: string[] = []
  const context: string[] = []
  for (const block of prompt) {
    if (block.type === 'text') inline.push(block.text)
    else if (block.type === 'resource_link') inline.push(block.uri)
    else if (block.type === 'resource') {
      inline.push(block.resource.uri)
      if ('text' in block.resource) {
        context.push(`<context ref="${block.resource.uri}">\n${block.resource.text}\n</context>`)
      }
    }
  }
  return [inline.join(''), ...context].join('\n\n')
}

/**
 * The flow's input for a turn: the config's `to_input`, or the turn's text,
 * which `ServeAcpConfig` allows only when the flow takes a string.
 */
function turn_input<i, o>(config: ServeAcpConfig<i, o>, turn: AcpTurn): i {
  if (config.to_input !== undefined) return config.to_input(turn)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return turn.text as i
}

/**
 * The default `to_text`: a string as-is, anything else as JSON, and nothing
 * at all for a flow that returns nothing.
 */
function default_to_text(output: unknown): string {
  return typeof output === 'string' ? output : (JSON.stringify(output) ?? '')
}

/**
 * Wrap a turn's final text as the message update that carries it.
 */
function agent_message(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}

/**
 * Count a message update the client was sent toward the turn's reply. Only
 * text joins the reply's text, but any message counts as a reply, so a flow
 * that sent an image doesn't get a `to_text` message after it.
 */
function note_reply(reply: Reply, update: SessionUpdate): void {
  if (update.sessionUpdate !== 'agent_message_chunk') return
  reply.sent = true
  if (update.content.type === 'text') reply.text += update.content.text
}

/**
 * Append a turn to the session's history: the user's text, then the reply
 * text the client was sent, when there was any.
 */
function record_exchange(history: AcpHistoryEntry[], user_text: string, reply_text: string): void {
  history.push({ role: 'user', text: user_text })
  if (reply_text !== '') history.push({ role: 'agent', text: reply_text })
}

/**
 * Settle a run's result into a value, so a run that fails while the turn is
 * still sending never surfaces as an unhandled rejection.
 */
function settle<o>(result: Promise<o>): Promise<Settled<o>> {
  return result.then(
    (output): Settled<o> => ({ ok: true, output }),
    (error: unknown): Settled<o> => ({ ok: false, error }),
  )
}

/**
 * Say on stderr that the run outran the client and dropped events, since the
 * reply the client shows is missing text from that point on.
 */
function warn_dropped(event: TrajectoryEvent): void {
  process.stderr.write(
    `fascicle/acp: the client read updates slower than the run produced them, so ${String(event['count'])} run events were dropped and the reply is missing text from that point; send the prompt again for the whole reply\n`,
  )
}

/**
 * Send each run event's updates in order. Once the turn is cancelled nothing
 * more is sent, and leaving the loop closes the run's event stream.
 */
async function forward<i, o>(
  events: AsyncIterable<TrajectoryEvent>,
  config: ServeAcpConfig<i, o>,
  session: AcpSession,
  cancelled: AbortSignal,
  send: SendUpdate,
): Promise<void> {
  const state = create_acp_mapper_state({ stream: config.stream, session })
  const to_updates = config.to_updates ?? to_session_updates
  for await (const event of events) {
    if (event.kind === 'events_dropped') warn_dropped(event)
    for (const update of to_updates(event, state)) {
      if (cancelled.aborted) return
      await send(update)
    }
  }
}

/**
 * Run the flow for one turn, forward its updates, and record the exchange.
 * The run has always settled by the time this returns or throws, so a turn
 * never leaves a run behind.
 */
async function run_turn<i, o>(
  config: ServeAcpConfig<i, o>,
  record: SessionRecord<i, o>,
  prompt: ReadonlyArray<ContentBlock>,
  cancelled: AbortSignal,
  send: SendUpdate,
): Promise<PromptResponse> {
  const turn: AcpTurn = {
    session_id: record.session.id,
    cwd: record.session.cwd,
    text: turn_text(prompt),
    prompt,
    history: [...record.history],
  }
  const reply: Reply = { sent: false, text: '' }
  const send_update: SendUpdate = async (update) => {
    await send(update)
    note_reply(reply, update)
  }
  const stop = new AbortController()
  // A turn cancelled before its consumer caught up leaves previews nobody
  // took, and raw ids repeat from turn to turn.
  reset_previews(record.session)
  const handle = run.stream(record.flow, turn_input(config, turn), {
    abort: AbortSignal.any([cancelled, stop.signal]),
    install_signal_handlers: false,
    // Stryker disable next-line ConditionalExpression: run.stream reads an undefined trajectory as none, so the spread only satisfies exactOptionalPropertyTypes.
    ...(config.trajectory === undefined ? {} : { trajectory: config.trajectory }),
  })
  const outcome = settle(handle.result)
  try {
    await forward(handle.events, config, record.session, cancelled, send_update)
    const result = await outcome
    if (!cancelled.aborted) {
      if (!result.ok) throw result.error
      const final_text = (config.to_text ?? default_to_text)(result.output)
      if (!reply.sent && final_text !== '') await send_update(agent_message(final_text))
    }
  } catch (err: unknown) {
    stop.abort(new aborted_error('the prompt turn failed before its run finished'))
    await outcome
    if (!cancelled.aborted) throw err
  }
  record_exchange(record.history, turn.text, reply.text)
  return { stopReason: cancelled.aborted ? 'cancelled' : 'end_turn' }
}

/**
 * Run one prompt turn and answer with its stop reason. A new prompt cancels
 * the session's turn in flight and waits for it to settle first, so it sees
 * that turn in its history and never runs beside it.
 */
export async function prompt_turn<i, o>(
  config: ServeAcpConfig<i, o>,
  record: SessionRecord<i, o>,
  prompt: ReadonlyArray<ContentBlock>,
  request_signal: AbortSignal,
  send: SendUpdate,
): Promise<PromptResponse> {
  const previous = record.last_turn
  const cancel = new AbortController()
  const { promise: settled, resolve: settle_turn } = Promise.withResolvers<void>()
  record.last_turn = { cancel, settled }
  try {
    if (previous !== null) {
      previous.cancel.abort(new aborted_error('a new prompt replaced the turn'))
      await previous.settled
    }
    const signals = [cancel.signal, request_signal, ...(config.abort === undefined ? [] : [config.abort])]
    return await run_turn(config, record, prompt, AbortSignal.any(signals), send)
  } finally {
    settle_turn()
  }
}

/**
 * Cancel the session's latest turn on the client's `session/cancel`.
 */
export function cancel_turn<i, o>(record: SessionRecord<i, o>): void {
  record.last_turn?.cancel.abort(new aborted_error('the ACP client cancelled the turn'))
}
