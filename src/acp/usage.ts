/**
 * usage: what a session has spent and how full its context is, read off the
 * run events of its turns, and the stop reason a turn's model calls earn.
 *
 * The engine's tool loop records a `response_received` event for each model
 * turn and a `cost` event for each turn it prices, and a model call records
 * a `finish` chunk once its loop ends. A provider that runs its own loop,
 * such as `claude_cli`, reports each turn as a `step_finish` chunk instead,
 * and some providers send both. The context a session holds is the last
 * model turn's input and output, since the next turn sends all of it again,
 * and its cost is the sum of every priced turn. The client draws both as a
 * context ring, which needs the model's context window, so the agent sends
 * them only when its config names one.
 */

import type { SessionUpdate, StopReason } from '@agentclientprotocol/sdk'
import type { TrajectoryEvent } from '#core'
import type { FinishReason, StreamChunk } from '#engine'
import { is_stream_chunk } from './to_session_updates.js'

/** What a session has spent so far, kept across its turns. */
export type SessionUsage = {
  /** The last model turn's input and output tokens, which the next turn sends again. */
  context_tokens: number
  /** Every priced model turn's cost, in US dollars. */
  cost_usd: number
  /** Whether any model turn was priced; the client hears no cost until one is. */
  priced: boolean
}

/**
 * A session's usage before its first turn.
 */
export function create_session_usage(): SessionUsage {
  return { context_tokens: 0, cost_usd: 0, priced: false }
}

/**
 * The stream chunk a `model_chunk` event carries, or undefined for any other
 * event.
 */
function chunk_of(event: TrajectoryEvent): StreamChunk | undefined {
  if (event.kind !== 'model_chunk') return undefined
  const chunk = event['chunk']
  return is_stream_chunk(chunk) ? chunk : undefined
}

/**
 * The tokens a model turn left in the context, from either way a turn is
 * reported, or undefined for any other event.
 */
function context_of(event: TrajectoryEvent): number | undefined {
  if (event.kind === 'response_received') {
    const input = event['input_tokens']
    const output = event['output_tokens']
    return typeof input === 'number' && typeof output === 'number' ? input + output : undefined
  }
  const chunk = chunk_of(event)
  return chunk?.kind === 'step_finish' ? chunk.usage.input_tokens + chunk.usage.output_tokens : undefined
}

/**
 * Fold one run event into the session's usage, and say whether it changed,
 * so a turn that a provider reports twice tells the client once.
 */
export function note_usage(usage: SessionUsage, event: TrajectoryEvent): boolean {
  if (event.kind === 'cost') {
    const total = event['total_usd']
    if (typeof total !== 'number') return false
    usage.cost_usd += total
    usage.priced = true
    return true
  }
  const context = context_of(event)
  if (context === undefined || context === usage.context_tokens) return false
  usage.context_tokens = context
  return true
}

/**
 * The session's usage as the update a client draws its context ring from,
 * against a context window of `size` tokens.
 */
export function usage_update(usage: SessionUsage, size: number): SessionUpdate {
  return {
    sessionUpdate: 'usage_update',
    used: usage.context_tokens,
    size,
    ...(usage.priced ? { cost: { amount: usage.cost_usd, currency: 'USD' } } : {}),
  }
}

/**
 * The finish reason a model call's `finish` chunk carries, or undefined for
 * any other event.
 */
export function finish_reason_of(event: TrajectoryEvent): FinishReason | undefined {
  const chunk = chunk_of(event)
  return chunk?.kind === 'finish' ? chunk.finish_reason : undefined
}

/**
 * The stop reason for a turn that wasn't cancelled, from the finish reason of
 * the last model call that finished in it, which is the one whose reply the
 * user reads. A call that ran out of tool turns, ran out of output tokens, or
 * was stopped by the provider's filter says so, rather than reading as a turn
 * that finished.
 */
export function stop_reason_for(finish: FinishReason | undefined): StopReason {
  if (finish === 'max_steps') return 'max_turn_requests'
  if (finish === 'length') return 'max_tokens'
  if (finish === 'content_filter') return 'refusal'
  return 'end_turn'
}
