/**
 * One message to a remote A2A agent, and what its task comes to.
 *
 * `a2a_step` sends each round through here. The message goes out as a
 * stream when the remote agent's card says it can stream, and as a blocking
 * `SendMessage` otherwise. Either way a task that's still working when the
 * call returns is polled with `GetTask`, on a backoff that starts at half a
 * second and stops growing at five, until it rests.
 *
 * While a stream is read, each text chunk of the task's artifacts is
 * recorded as a `model_chunk` event under the step's id when the run asked
 * for chunks, so every consumer that shows a model call's text shows the
 * remote agent's too. A status message becomes an `emit` event, and so does
 * the id of the task a round opens.
 *
 * A round ends in one of two ways the flow can go on from: the task
 * completed, or it asked a question. A task that failed, was rejected or
 * canceled, or wants credentials throws `a2a_error`. An abort stops the
 * stream, asks the remote agent to cancel the task (best effort), and
 * throws the abort's reason.
 *
 * What a round resolves is plain JSON, bytes included, because `a2a_step`
 * keeps it in a checkpoint.
 */

import { randomUUID } from 'node:crypto'
import type { Artifact, Message, Part, SendMessageRequest, StreamResponse, Task, TaskState } from '@a2a-js/sdk'
import type { Client } from '@a2a-js/sdk/client'
import { aborted_error } from '#core'
import type { RunContext } from '#core'
import { a2a_error } from './errors.js'
import { data_of, text_of, to_plain } from './parts.js'
import type { A2aClientSdk } from './sdk_loader.js'

/** A remote agent, reached: the SDK, a client for it, and whether it streams. */
export type Remote = {
  readonly sdk: A2aClientSdk
  readonly client: Client
  readonly streams: boolean
}

/** What one round sends: the parts, and the task and context they continue. */
export type Outgoing = {
  readonly round: number
  readonly parts: ReadonlyArray<Part>
  readonly task_id?: string | undefined
  readonly context_id?: string | undefined
}

/** Where a round came to rest, as plain JSON. */
export type Round =
  | {
      readonly kind: 'completed'
      readonly task_id: string
      readonly context_id: string
      /** The task's artifacts, through `to_plain`. */
      readonly artifacts: unknown
    }
  | {
      readonly kind: 'question'
      readonly task_id: string
      readonly context_id: string
      readonly text: string
      readonly data: ReadonlyArray<unknown>
    }

/** What a round has seen of its task so far. */
type Seen = {
  task_id: string
  context_id: string
  state: TaskState | undefined
  status: Message | undefined
  /** A reply that came as a bare message, with no task behind it. */
  reply: Message | undefined
  readonly artifacts: Map<string, Artifact>
}

const FIRST_POLL_MS = 500
const MAX_POLL_MS = 5_000
// How long an aborted round waits for the remote agent to take its cancel.
const CANCEL_WAIT_MS = 5_000

/**
 * The request that carries `outgoing` as one user message.
 */
function request_for(remote: Remote, outgoing: Outgoing): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId: randomUUID(),
      contextId: outgoing.context_id ?? '',
      taskId: outgoing.task_id ?? '',
      role: remote.sdk.wire.Role.ROLE_USER,
      parts: [...outgoing.parts],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  }
}

/**
 * Take a whole task as the latest word on it.
 */
function see_task(seen: Seen, task: Task): void {
  seen.task_id = task.id
  seen.context_id = task.contextId
  seen.state = task.status?.state
  seen.status = task.status?.message
  seen.artifacts.clear()
  for (const artifact of task.artifacts) seen.artifacts.set(artifact.artifactId, artifact)
}

/**
 * Fold one chunk of an artifact into what the round has of it, the way the
 * task itself does: a chunk that appends adds its parts, and any other
 * replaces the artifact.
 */
function see_artifact(seen: Seen, artifact: Artifact, append: boolean): void {
  const held = seen.artifacts.get(artifact.artifactId)
  const parts = append && held !== undefined ? [...held.parts, ...artifact.parts] : artifact.parts
  seen.artifacts.set(artifact.artifactId, { ...(held ?? artifact), ...artifact, parts })
}

/**
 * Whether a task is still on its way somewhere, so the round keeps asking.
 */
function is_working(remote: Remote, state: TaskState | undefined): boolean {
  const states = remote.sdk.wire.TaskState
  return state === states.TASK_STATE_WORKING || state === states.TASK_STATE_SUBMITTED
}

/**
 * Wait `ms`, or reject with the signal's reason as soon as it aborts.
 */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const on_abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new aborted_error('aborted', { reason: signal.reason }))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', on_abort)
      resolve()
    }, ms)
    if (signal.aborted) on_abort()
    else signal.addEventListener('abort', on_abort, { once: true })
  })
}

/**
 * Where the round rests, given the last the task said: a completion, a
 * question, or an `a2a_error` for anything the flow can't go on from.
 */
function rest_of(remote: Remote, seen: Seen): Round {
  const { task_id, context_id } = seen
  if (seen.reply !== undefined) {
    const artifact: Artifact = {
      artifactId: seen.reply.messageId,
      name: '',
      description: '',
      parts: seen.reply.parts,
      metadata: undefined,
      extensions: [],
    }
    return { kind: 'completed', task_id, context_id, artifacts: to_plain([artifact]) }
  }
  const states = remote.sdk.wire.TaskState
  if (seen.state === states.TASK_STATE_COMPLETED) {
    return { kind: 'completed', task_id, context_id, artifacts: to_plain([...seen.artifacts.values()]) }
  }
  const parts = seen.status?.parts ?? []
  if (seen.state === states.TASK_STATE_INPUT_REQUIRED) {
    return { kind: 'question', task_id, context_id, text: text_of(parts, '\n'), data: data_of(parts) }
  }
  const state = seen.state === undefined ? 'TASK_STATE_UNSPECIFIED' : remote.sdk.wire.taskStateToJSON(seen.state)
  const status_text = text_of(parts, '\n')
  throw new a2a_error(
    `the remote task ${task_id} ended in ${state}${status_text === '' ? '' : `: ${status_text}`}`,
    { state, status_text, task_id },
  )
}

/**
 * Send one message to the remote agent and resolve where its task rests.
 */
export async function send_round(remote: Remote, step_id: string, outgoing: Outgoing, ctx: RunContext): Promise<Round> {
  const { client } = remote
  const options = { signal: ctx.abort }
  const seen: Seen = {
    task_id: outgoing.task_id ?? '',
    context_id: outgoing.context_id ?? '',
    state: undefined,
    status: undefined,
    reply: undefined,
    artifacts: new Map(),
  }

  const see_status = (state: TaskState | undefined, message: Message | undefined): void => {
    seen.state = state
    seen.status = message
    if (message === undefined) return
    ctx.emit({
      step_id,
      a2a_status: {
        task_id: seen.task_id,
        state: state === undefined ? 'TASK_STATE_UNSPECIFIED' : remote.sdk.wire.taskStateToJSON(state),
        text: text_of(message.parts, '\n'),
      },
    })
  }

  const see_chunk = (artifact: Artifact, append: boolean): void => {
    see_artifact(seen, artifact, append)
    const text = text_of(artifact.parts)
    if (!ctx.streaming || text === '') return
    ctx.trajectory.record({ kind: 'model_chunk', step_id, chunk: { kind: 'text', text, step_index: 0 } })
  }

  // Say which remote task the round opened, once, so that whoever watches
  // the run can find the task on the other side.
  let announced = outgoing.task_id !== undefined
  const announce = (): void => {
    if (announced || seen.task_id === '') return
    announced = true
    ctx.emit({ step_id, a2a_task: { task_id: seen.task_id, context_id: seen.context_id } })
  }

  const see = (event: StreamResponse): void => {
    const payload = event.payload
    if (payload === undefined) return
    if (payload.$case === 'task') {
      see_task(seen, payload.value)
      announce()
    }
    if (payload.$case === 'message') seen.reply = payload.value
    if (payload.$case === 'statusUpdate') {
      seen.task_id = payload.value.taskId
      see_status(payload.value.status?.state, payload.value.status?.message)
    }
    if (payload.$case === 'artifactUpdate' && payload.value.artifact !== undefined) {
      see_chunk(payload.value.artifact, payload.value.append)
    }
  }

  const exchange = async (): Promise<void> => {
    const request = request_for(remote, outgoing)
    if (remote.streams) {
      for await (const event of client.sendMessageStream(request, options)) see(event)
    } else {
      const answer = await client.sendMessage(request, options)
      if ('messageId' in answer) seen.reply = answer
      else see_task(seen, answer)
      announce()
    }
    let wait_ms = FIRST_POLL_MS
    while (seen.reply === undefined && is_working(remote, seen.state)) {
      await pause(wait_ms, ctx.abort)
      wait_ms = Math.min(MAX_POLL_MS, wait_ms * 2)
      see_task(seen, await client.getTask({ tenant: '', id: seen.task_id, historyLength: undefined }, options))
    }
  }

  try {
    await exchange()
  } catch (err) {
    if (!ctx.abort.aborted) throw err
    if (seen.task_id !== '') {
      const cancel = client.cancelTask(
        { tenant: '', id: seen.task_id, metadata: undefined },
        { signal: AbortSignal.timeout(CANCEL_WAIT_MS) },
      )
      // Best effort: the remote agent may be gone, or the task already over.
      await cancel.catch(() => {})
    }
    const reason: unknown = ctx.abort.reason
    throw reason instanceof Error ? reason : new aborted_error('aborted', { reason })
  }
  return rest_of(remote, seen)
}
