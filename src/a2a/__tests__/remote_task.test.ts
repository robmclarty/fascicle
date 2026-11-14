import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Artifact, Message, Part, SendMessageRequest, StreamResponse, Task, TaskState } from '@a2a-js/sdk'
import type { Client } from '@a2a-js/sdk/client'
import { aborted_error } from '#core'
import type { RunContext, TrajectoryEvent } from '#core'
import { a2a_error } from '../errors.js'
import { data_part, from_plain, text_part } from '../parts.js'
import { send_round } from '../remote_task.js'
import type { Outgoing, Remote } from '../remote_task.js'
import { load_a2a_client } from '../sdk_loader.js'

const sdk = await load_a2a_client()
const STATE = sdk.wire.TaskState

type Calls = {
  readonly sent: SendMessageRequest[]
  readonly got: string[]
  readonly canceled: Array<{ readonly id: string; readonly signal: AbortSignal | undefined }>
}

type Script = {
  /** What a streamed send yields, or a function that yields it. */
  readonly stream?: ReadonlyArray<StreamResponse> | ((signal: AbortSignal | undefined) => AsyncGenerator<StreamResponse>)
  /** What a blocking send resolves. */
  readonly answer?: Task | Message
  /** What each `getTask` resolves, in order. */
  readonly polls?: ReadonlyArray<Task>
  readonly cancel?: () => Promise<Task>
}

function artifact(id: string, parts: Part[]): Artifact {
  return { artifactId: id, name: '', description: '', parts, metadata: undefined, extensions: [] }
}

function message(parts: Part[], id = 'm1'): Message {
  return {
    messageId: id,
    contextId: 'ctx-1',
    taskId: 'task-1',
    role: sdk.wire.Role.ROLE_AGENT,
    parts,
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function task(state: TaskState | undefined, options: { artifacts?: Artifact[]; status?: Part[] } = {}): Task {
  return {
    id: 'task-1',
    contextId: 'ctx-1',
    status:
      state === undefined
        ? undefined
        : { state, message: options.status === undefined ? undefined : message(options.status), timestamp: undefined },
    artifacts: options.artifacts ?? [],
    history: [],
    metadata: undefined,
  }
}

const task_event = (value: Task): StreamResponse => ({ payload: { $case: 'task', value } })
const status_event = (state: TaskState, status?: Part[]): StreamResponse => ({
  payload: {
    $case: 'statusUpdate',
    value: {
      taskId: 'task-1',
      contextId: 'ctx-1',
      status: { state, message: status === undefined ? undefined : message(status), timestamp: undefined },
      metadata: undefined,
    },
  },
})
const artifact_event = (value: Artifact | undefined, append = false): StreamResponse => ({
  payload: {
    $case: 'artifactUpdate',
    value: { taskId: 'task-1', contextId: 'ctx-1', artifact: value, append, lastChunk: false, metadata: undefined },
  },
})

// A remote whose client plays a script and records what it was asked.
function remote_for(script: Script, streams: boolean): { readonly remote: Remote; readonly calls: Calls } {
  const calls: Calls = { sent: [], got: [], canceled: [] }
  const polls = [...(script.polls ?? [])]
  const client = {
    sendMessage: async (request: SendMessageRequest) => {
      calls.sent.push(request)
      if (script.answer === undefined) throw new Error('the script has no blocking answer')
      return script.answer
    },
    sendMessageStream: async function* (request: SendMessageRequest, options?: { signal?: AbortSignal }) {
      calls.sent.push(request)
      const source = script.stream ?? []
      if (typeof source === 'function') yield* source(options?.signal)
      else yield* source
    },
    getTask: async (request: { id: string }) => {
      calls.got.push(request.id)
      const next = polls.shift()
      if (next === undefined) throw new Error('the script ran out of polls')
      return next
    },
    cancelTask: async (request: { id: string }, options?: { signal?: AbortSignal }) => {
      calls.canceled.push({ id: request.id, signal: options?.signal })
      return script.cancel === undefined ? task(STATE.TASK_STATE_CANCELED) : script.cancel()
    },
  }
  return { remote: { sdk, client: client as unknown as Client, streams }, calls }
}

function context(options: { streaming?: boolean; abort?: AbortSignal } = {}): {
  readonly ctx: RunContext
  readonly events: TrajectoryEvent[]
} {
  const events: TrajectoryEvent[] = []
  const ctx: RunContext = {
    run_id: 'run',
    trajectory: { record: (event) => events.push(event), start_span: () => 'span', end_span: () => {} },
    state: new Map(),
    abort: options.abort ?? new AbortController().signal,
    emit: (event) => events.push({ ...event, kind: 'emit' }),
    on_cleanup: () => {},
    call: () => {
      throw new Error('not used')
    },
    streaming: options.streaming ?? false,
  }
  return { ctx, events }
}

const FIRST: Outgoing = { round: 1, parts: [text_part('v1.2')] }

afterEach(() => {
  vi.useRealTimers()
})

describe('send_round: what it sends', () => {
  it('sends one user message with the parts, and no task or context on the first round', async () => {
    const { remote, calls } = remote_for({ answer: task(STATE.TASK_STATE_COMPLETED) }, false)
    await send_round(remote, 'ask', FIRST, context().ctx)
    expect(calls.sent).toHaveLength(1)
    expect(calls.sent[0]).toEqual({
      tenant: '',
      message: {
        messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        contextId: '',
        taskId: '',
        role: sdk.wire.Role.ROLE_USER,
        parts: [text_part('v1.2')],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: undefined,
    })
  })

  it('names the task and the context a later round continues', async () => {
    const { remote, calls } = remote_for({ answer: task(STATE.TASK_STATE_COMPLETED) }, false)
    await send_round(remote, 'ask', { round: 2, parts: [data_part({ ok: true })], task_id: 'task-1', context_id: 'ctx-1' }, context().ctx)
    expect(calls.sent[0]?.message).toMatchObject({ taskId: 'task-1', contextId: 'ctx-1', parts: [data_part({ ok: true })] })
  })

  it('streams when the remote streams, and sends a blocking message when it does not', async () => {
    const streamed = remote_for({ stream: [task_event(task(STATE.TASK_STATE_COMPLETED))] }, true)
    expect((await send_round(streamed.remote, 'ask', FIRST, context().ctx)).kind).toBe('completed')
    const blocking = remote_for({ answer: task(STATE.TASK_STATE_COMPLETED), stream: [task_event(task(STATE.TASK_STATE_FAILED))] }, false)
    expect((await send_round(blocking.remote, 'ask', FIRST, context().ctx)).kind).toBe('completed')
  })
})

describe('send_round: a completed task', () => {
  it('resolves the task ids and its artifacts, as plain JSON that holds its bytes', async () => {
    const bytes: Part = { content: { $case: 'raw', value: Buffer.from([1, 2]) }, metadata: undefined, filename: 'b', mediaType: 'x/y' }
    const done = task(STATE.TASK_STATE_COMPLETED, { artifacts: [artifact('a1', [text_part('notes'), bytes])] })
    const { remote } = remote_for({ answer: done }, false)

    const round = await send_round(remote, 'ask', FIRST, context().ctx)

    expect(round).toMatchObject({ kind: 'completed', task_id: 'task-1', context_id: 'ctx-1' })
    if (round.kind !== 'completed') throw new Error('expected a completed round')
    expect(JSON.parse(JSON.stringify(round.artifacts))).toEqual(round.artifacts)
    expect(from_plain(round.artifacts)).toEqual([artifact('a1', [text_part('notes'), bytes])])
  })

  it('folds a stream of artifact chunks the way the task does', async () => {
    const { remote } = remote_for(
      {
        stream: [
          task_event(task(STATE.TASK_STATE_WORKING, { artifacts: [artifact('old', [text_part('from an earlier drive')])] })),
          artifact_event(artifact('a1', [text_part('one ')])),
          artifact_event(artifact('a1', [text_part('two')]), true),
          artifact_event(artifact('a2', [text_part('appended to nothing')]), true),
          artifact_event(artifact('a3', [text_part('first')])),
          artifact_event(artifact('a3', [text_part('replaced')])),
          artifact_event(undefined),
          status_event(STATE.TASK_STATE_COMPLETED),
        ],
      },
      true,
    )
    const round = await send_round(remote, 'ask', FIRST, context().ctx)
    if (round.kind !== 'completed') throw new Error('expected a completed round')
    expect(from_plain(round.artifacts)).toEqual([
      artifact('old', [text_part('from an earlier drive')]),
      artifact('a1', [text_part('one '), text_part('two')]),
      artifact('a2', [text_part('appended to nothing')]),
      artifact('a3', [text_part('replaced')]),
    ])
  })

  it('takes a whole task as the latest word, dropping the chunks it had', async () => {
    const { remote } = remote_for(
      {
        stream: [
          task_event(task(STATE.TASK_STATE_WORKING)),
          artifact_event(artifact('a1', [text_part('partial')])),
          status_event(STATE.TASK_STATE_WORKING),
        ],
        polls: [task(STATE.TASK_STATE_COMPLETED, { artifacts: [artifact('a9', [text_part('whole')])] })],
      },
      true,
    )
    vi.useFakeTimers()
    const sending = send_round(remote, 'ask', FIRST, context().ctx)
    await vi.advanceTimersByTimeAsync(500)
    const round = await sending
    if (round.kind !== 'completed') throw new Error('expected a completed round')
    expect(from_plain(round.artifacts)).toEqual([artifact('a9', [text_part('whole')])])
  })

  it('reads a bare message as the whole reply, streamed or not', async () => {
    const reply = message([text_part('just a message')], 'reply-1')
    const expected = [artifact('reply-1', [text_part('just a message')])]

    const blocking = remote_for({ answer: reply }, false)
    const from_answer = await send_round(blocking.remote, 'ask', { ...FIRST, context_id: 'ctx-9' }, context().ctx)
    expect(from_answer).toMatchObject({ kind: 'completed', task_id: '', context_id: 'ctx-9' })
    if (from_answer.kind !== 'completed') throw new Error('expected a completed round')
    expect(from_plain(from_answer.artifacts)).toEqual(expected)
    expect(blocking.calls.got).toEqual([])

    const streamed = remote_for({ stream: [{ payload: { $case: 'message', value: reply } }] }, true)
    const from_stream = await send_round(streamed.remote, 'ask', FIRST, context().ctx)
    if (from_stream.kind !== 'completed') throw new Error('expected a completed round')
    expect(from_plain(from_stream.artifacts)).toEqual(expected)
    expect(streamed.calls.got).toEqual([])
  })

  it('skips a stream frame with no payload', async () => {
    const { remote } = remote_for({ stream: [{ payload: undefined }, task_event(task(STATE.TASK_STATE_COMPLETED))] }, true)
    expect((await send_round(remote, 'ask', FIRST, context().ctx)).kind).toBe('completed')
  })
})

describe('send_round: a question and a failure', () => {
  it('resolves a question with the status text, joined by lines, and its data', async () => {
    const asking = task(STATE.TASK_STATE_INPUT_REQUIRED, {
      status: [text_part('Publish?'), data_part({ draft: 'notes' }), text_part('Answer yes or no.')],
    })
    const { remote } = remote_for({ answer: asking }, false)
    expect(await send_round(remote, 'ask', FIRST, context().ctx)).toEqual({
      kind: 'question',
      task_id: 'task-1',
      context_id: 'ctx-1',
      text: 'Publish?\nAnswer yes or no.',
      data: [{ draft: 'notes' }],
    })
  })

  it('resolves a question with no text when the status has no message', async () => {
    const { remote } = remote_for({ answer: task(STATE.TASK_STATE_INPUT_REQUIRED) }, false)
    expect(await send_round(remote, 'ask', FIRST, context().ctx)).toMatchObject({ kind: 'question', text: '', data: [] })
  })

  it.each([
    [STATE.TASK_STATE_FAILED, 'TASK_STATE_FAILED'],
    [STATE.TASK_STATE_REJECTED, 'TASK_STATE_REJECTED'],
    [STATE.TASK_STATE_CANCELED, 'TASK_STATE_CANCELED'],
    [STATE.TASK_STATE_AUTH_REQUIRED, 'TASK_STATE_AUTH_REQUIRED'],
  ])('throws a2a_error for a task that ends in state %s', async (state, name) => {
    const ended = task(state, { status: [text_part('line one'), text_part('line two')] })
    const { remote } = remote_for({ answer: ended }, false)
    const err: unknown = await send_round(remote, 'ask', FIRST, context().ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(a2a_error)
    expect(err).toMatchObject({
      message: `the remote task task-1 ended in ${name}: line one\nline two`,
      state: name,
      status_text: 'line one\nline two',
      task_id: 'task-1',
    })
  })

  it('leaves the colon out when the task ended with no status text, and names a missing state', async () => {
    const silent = remote_for({ answer: task(STATE.TASK_STATE_FAILED) }, false)
    await expect(send_round(silent.remote, 'ask', FIRST, context().ctx)).rejects.toMatchObject({
      message: 'the remote task task-1 ended in TASK_STATE_FAILED',
      status_text: '',
    })
    const stateless = remote_for({ answer: task(undefined) }, false)
    await expect(send_round(stateless.remote, 'ask', FIRST, context().ctx)).rejects.toMatchObject({
      message: 'the remote task task-1 ended in TASK_STATE_UNSPECIFIED',
      state: 'TASK_STATE_UNSPECIFIED',
    })
  })
})

describe('send_round: what it records', () => {
  it('records each text chunk as a model_chunk under the step id when the run asked for chunks', async () => {
    const script: Script = {
      stream: [
        task_event(task(STATE.TASK_STATE_WORKING)),
        artifact_event(artifact('a1', [text_part('one '), data_part({ skipped: true }), text_part('two')])),
        artifact_event(artifact('a1', [data_part({ only: 'data' })]), true),
        status_event(STATE.TASK_STATE_COMPLETED),
      ],
    }
    const streaming = context({ streaming: true })
    await send_round(remote_for(script, true).remote, 'ask', FIRST, streaming.ctx)
    expect(streaming.events.filter((event) => event.kind === 'model_chunk')).toEqual([
      { kind: 'model_chunk', step_id: 'ask', chunk: { kind: 'text', text: 'one two', step_index: 0 } },
    ])

    const quiet = context({ streaming: false })
    await send_round(remote_for(script, true).remote, 'ask', FIRST, quiet.ctx)
    expect(quiet.events.filter((event) => event.kind === 'model_chunk')).toEqual([])
  })

  it('emits the task it opened once, then each change of its status', async () => {
    const { remote } = remote_for(
      {
        stream: [
          task_event(task(STATE.TASK_STATE_SUBMITTED)),
          task_event(task(STATE.TASK_STATE_WORKING)),
          status_event(STATE.TASK_STATE_WORKING),
          status_event(STATE.TASK_STATE_COMPLETED, [text_part('all'), text_part('done')]),
        ],
      },
      true,
    )
    const { ctx, events } = context()
    await send_round(remote, 'ask', FIRST, ctx)
    expect(events).toEqual([
      { kind: 'emit', step_id: 'ask', a2a_task: { task_id: 'task-1', context_id: 'ctx-1' } },
      { kind: 'emit', step_id: 'ask', a2a_status: { task_id: 'task-1', state: 'TASK_STATE_WORKING', text: '' } },
      { kind: 'emit', step_id: 'ask', a2a_status: { task_id: 'task-1', state: 'TASK_STATE_COMPLETED', text: 'all\ndone' } },
    ])
  })

  it('emits the task a blocking send opened, and none for a round that continues one', async () => {
    const opened = context()
    await send_round(remote_for({ answer: task(STATE.TASK_STATE_COMPLETED) }, false).remote, 'ask', FIRST, opened.ctx)
    expect(opened.events).toEqual([{ kind: 'emit', step_id: 'ask', a2a_task: { task_id: 'task-1', context_id: 'ctx-1' } }])

    const continued = context()
    const later: Outgoing = { round: 2, parts: [], task_id: 'task-1', context_id: 'ctx-1' }
    await send_round(remote_for({ answer: task(STATE.TASK_STATE_COMPLETED) }, false).remote, 'ask', later, continued.ctx)
    expect(continued.events).toEqual([])

    const bare = context()
    await send_round(remote_for({ answer: message([text_part('hi')]) }, false).remote, 'ask', FIRST, bare.ctx)
    expect(bare.events).toEqual([])
  })

  it('emits a status with no state as unspecified', async () => {
    const stateless: StreamResponse = {
      payload: { $case: 'statusUpdate', value: { taskId: 'task-1', contextId: 'ctx-1', status: undefined, metadata: undefined } },
    }
    const { remote } = remote_for({ stream: [task_event(task(STATE.TASK_STATE_WORKING)), stateless, status_event(STATE.TASK_STATE_COMPLETED)] }, true)
    const { ctx, events } = context()
    await send_round(remote, 'ask', FIRST, ctx)
    expect(events[1]).toMatchObject({ a2a_status: { state: 'TASK_STATE_UNSPECIFIED', text: '' } })
  })
})

describe('send_round: polling', () => {
  it('polls a task that is still working on a backoff from half a second to five', async () => {
    const working = task(STATE.TASK_STATE_WORKING)
    const { remote, calls } = remote_for(
      {
        answer: task(STATE.TASK_STATE_SUBMITTED),
        polls: [working, working, working, working, working, task(STATE.TASK_STATE_COMPLETED)],
      },
      false,
    )
    vi.useFakeTimers()
    let settled = false
    const sending = send_round(remote, 'ask', FIRST, context().ctx).finally(() => {
      settled = true
    })
    const waits = [500, 1_000, 2_000, 4_000, 5_000, 5_000]
    for (const [index, wait] of waits.entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(calls.got).toHaveLength(index)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls.got).toHaveLength(index + 1)
    }
    await sending
    expect(settled).toBe(true)
    expect(calls.got).toEqual(Array.from({ length: 6 }, () => 'task-1'))
  })

  it('does not poll a task that came back resting', async () => {
    const { remote, calls } = remote_for({ answer: task(STATE.TASK_STATE_INPUT_REQUIRED) }, false)
    await send_round(remote, 'ask', FIRST, context().ctx)
    expect(calls.got).toEqual([])
  })
})

describe('send_round: abort', () => {
  // A stream that yields the task, then waits for the abort and fails the
  // way a fetch does.
  const until_aborted = (first: StreamResponse[]) =>
    async function* (signal: AbortSignal | undefined): AsyncGenerator<StreamResponse> {
      yield* first
      await new Promise<void>((resolve) => {
        if (signal?.aborted === true) resolve()
        signal?.addEventListener('abort', () => {
          resolve()
        })
      })
      throw new Error('fetch aborted')
    }

  it('asks the remote agent to cancel the task, then throws the abort reason', async () => {
    const controller = new AbortController()
    const { remote, calls } = remote_for({ stream: until_aborted([task_event(task(STATE.TASK_STATE_WORKING))]) }, true)
    const { ctx, events } = context({ abort: controller.signal })
    const sending = send_round(remote, 'ask', FIRST, ctx)
    await vi.waitFor(() => {
      expect(events).toHaveLength(1)
    })
    const reason = new Error('the caller gave up')
    controller.abort(reason)

    await expect(sending).rejects.toBe(reason)
    expect(calls.canceled.map((cancel) => cancel.id)).toEqual(['task-1'])
    expect(calls.canceled[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(calls.canceled[0]?.signal).not.toBe(controller.signal)
    expect(calls.canceled[0]?.signal?.aborted).toBe(false)
  })

  it('wraps a reason that is not an error, and throws even when the cancel fails', async () => {
    const controller = new AbortController()
    const { remote, calls } = remote_for(
      {
        stream: until_aborted([task_event(task(STATE.TASK_STATE_WORKING))]),
        cancel: () => Promise.reject(new Error('the remote agent is gone')),
      },
      true,
    )
    const { ctx, events } = context({ abort: controller.signal })
    const sending = send_round(remote, 'ask', FIRST, ctx)
    await vi.waitFor(() => {
      expect(events).toHaveLength(1)
    })
    controller.abort('stop')

    const err: unknown = await sending.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(aborted_error)
    expect(err).toMatchObject({ message: 'aborted', reason: 'stop' })
    expect(calls.canceled).toHaveLength(1)
  })

  it('cancels nothing when the abort lands before the task has an id', async () => {
    const controller = new AbortController()
    const { remote, calls } = remote_for({ stream: until_aborted([]) }, true)
    const sending = send_round(remote, 'ask', FIRST, context({ abort: controller.signal }).ctx)
    const reason = new Error('early')
    controller.abort(reason)
    await expect(sending).rejects.toBe(reason)
    expect(calls.canceled).toEqual([])
  })

  it('rethrows a failure that is no abort as it is, and cancels nothing', async () => {
    const failure = new Error('connection refused')
    const { remote, calls } = remote_for(
      {
        stream: async function* () {
          yield task_event(task(STATE.TASK_STATE_WORKING))
          throw failure
        },
      },
      true,
    )
    await expect(send_round(remote, 'ask', FIRST, context().ctx)).rejects.toBe(failure)
    expect(calls.canceled).toEqual([])
  })

  it('stops waiting to poll as soon as the run is aborted, and cancels the task', async () => {
    const controller = new AbortController()
    const { remote, calls } = remote_for({ answer: task(STATE.TASK_STATE_WORKING), polls: [] }, false)
    const sending = send_round(remote, 'ask', FIRST, context({ abort: controller.signal }).ctx)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const reason = new Error('gave up while polling')
    controller.abort(reason)
    await expect(sending).rejects.toBe(reason)
    expect(calls.got).toEqual([])
    expect(calls.canceled.map((cancel) => cancel.id)).toEqual(['task-1'])
  })

  it('refuses to wait at all under a signal that is already aborted', async () => {
    const controller = new AbortController()
    controller.abort('already')
    const { remote, calls } = remote_for({ answer: task(STATE.TASK_STATE_WORKING), polls: [] }, false)
    const err: unknown = await send_round(remote, 'ask', FIRST, context({ abort: controller.signal }).ctx).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(aborted_error)
    expect(err).toMatchObject({ reason: 'already' })
    expect(calls.got).toEqual([])
  })
})
