import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Role, TaskState } from '@a2a-js/sdk'
import type { SendMessageRequest, StreamResponse } from '@a2a-js/sdk'
import { ClientFactory } from '@a2a-js/sdk/client'
import { memory_store } from '#adapters'
import { aborted_error, durable, run, sequence, step } from '#core'
import type { Step, TrajectoryEvent } from '#core'
import { a2a_step } from '../a2a_step.js'
import { a2a_error } from '../errors.js'
import { serve_a2a } from '../serve_a2a.js'
import type { A2aResult, A2aServer, A2aTurn, ServeA2aConfig } from '../types.js'
import { approval, CARD, gated_flow, latched, speaker } from './support/flows.js'

const QUIET = { install_signal_handlers: false } as const

const servers: A2aServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

// A port nothing listens on, found by binding one and letting it go.
function free_port(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'))
        else resolve(address.port)
      })
    })
  })
}

// Serve `flow` on a local port, with a card that names the address it bound.
// The config is loose on purpose: each test builds the pairing of flow and
// `to_input` that `A2aAgentConfig` would otherwise ask it to prove.
async function serve(flow: Step<never, unknown>, config: Record<string, unknown> = {}): Promise<A2aServer> {
  const port = await free_port()
  const base = { flow, card: { ...CARD, url: `http://127.0.0.1:${port}/` }, port, ...config }
  const server = await serve_a2a(base as unknown as ServeA2aConfig<string, unknown>)
  servers.push(server)
  return server
}

function recorder(): { readonly events: TrajectoryEvent[]; readonly logger: Parameters<typeof run>[2] } {
  const events: TrajectoryEvent[] = []
  let spans = 0
  return {
    events,
    logger: {
      ...QUIET,
      trajectory: {
        record: (event) => events.push(event),
        start_span: () => {
          spans += 1
          return `span_${spans}`
        },
        end_span: () => {},
      },
    },
  }
}

function user_request(text: string, task_id = '', context_id = ''): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId: crypto.randomUUID(),
      contextId: context_id,
      taskId: task_id,
      role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  }
}

describe("the SDK's own client against a served agent", () => {
  it('discovers the agent, messages it, and reads the task back', async () => {
    const server = await serve(step('echo', (text: string) => `echo: ${text}`))
    const client = await new ClientFactory().createFromUrl(server.url)

    const card = await client.getAgentCard()
    expect(card.name).toBe('release-notes')
    expect(card.capabilities?.streaming).toBe(true)

    const answer = await client.sendMessage(user_request('hello'))
    if ('messageId' in answer) throw new Error('expected a task')
    expect(answer.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(answer.artifacts[0]?.parts[0]?.content).toEqual({ $case: 'text', value: 'echo: hello' })

    const read = await client.getTask({ tenant: '', id: answer.id, historyLength: undefined })
    expect(read.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
  })

  it('streams from the agent, one event for each frame', async () => {
    const server = await serve(speaker('write', ['Release ', 'notes.']))
    const client = await new ClientFactory().createFromUrl(server.url)

    const events: StreamResponse[] = []
    for await (const event of client.sendMessageStream(user_request('v1.2'))) events.push(event)

    expect(events.map((event) => event.payload?.$case)).toEqual([
      'task',
      'statusUpdate',
      'artifactUpdate',
      'artifactUpdate',
      'statusUpdate',
    ])
    const last = events.at(-1)?.payload
    expect(last?.$case === 'statusUpdate' ? last.value.status?.state : undefined).toBe(TaskState.TASK_STATE_COMPLETED)
  })

  it('cancels a task that is running', async () => {
    const { flow, latch } = latched()
    const server = await serve(flow)
    const client = await new ClientFactory().createFromUrl(server.url)
    const started = await client.sendMessage({
      ...user_request('go'),
      configuration: {
        acceptedOutputModes: [],
        taskPushNotificationConfig: undefined,
        returnImmediately: true,
      },
    })
    if ('messageId' in started) throw new Error('expected a task')
    await latch.started

    const canceled = await client.cancelTask({ tenant: '', id: started.id, metadata: undefined })

    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED)
    expect(latch.aborted()).toBeInstanceOf(aborted_error)
  })
})

describe('a2a_step against a served agent', () => {
  it('streams the remote text into the run as model_chunk events, and resolves the artifacts', async () => {
    const server = await serve(speaker('write', ['Release ', 'notes ', 'done.']))
    const ask = a2a_step({ id: 'ask', url: server.url })
    const { events, logger } = recorder()

    const result = await run(ask, 'v1.2', { ...logger, record_chunks: true })

    expect(result).toMatchObject({ text: 'Release notes done.', data: [] })
    expect(result.task_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.context_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.artifacts).toHaveLength(1)
    const chunks = events.filter((event) => event.kind === 'model_chunk')
    expect(chunks.map((event) => event['step_id'])).toEqual(['ask', 'ask', 'ask'])
    expect(chunks.map((event) => (event['chunk'] as { text: string }).text)).toEqual(['Release ', 'notes ', 'done.'])
    expect(chunks.map((event) => (event['chunk'] as { kind: string }).kind)).toEqual(['text', 'text', 'text'])
  })

  it('records no chunks when the run did not ask for them', async () => {
    const server = await serve(speaker('write', ['Release ', 'notes.']))
    const { events, logger } = recorder()
    const result = await run(a2a_step({ id: 'ask', url: server.url }), 'v1.2', logger)
    expect(result.text).toBe('Release notes.')
    expect(events.filter((event) => event.kind === 'model_chunk')).toEqual([])
  })

  it('sends a blocking SendMessage when stream is false, and resolves the same result', async () => {
    const server = await serve(speaker('write', ['Release ', 'notes.']))
    const { events, logger } = recorder()

    const result = await run(a2a_step({ id: 'ask', url: server.url, stream: false }), 'v1.2', {
      ...logger,
      record_chunks: true,
    })

    expect(result.text).toBe('Release notes.')
    expect(events.filter((event) => event.kind === 'model_chunk')).toEqual([])
  })

  it('sends an object as a text part and a data part, and resolves the data the agent returns', async () => {
    const turns: A2aTurn[] = []
    const server = await serve(
      step('score', (turn: A2aTurn) => {
        turns.push(turn)
        return { received: turn.data, said: turn.text }
      }),
      { to_input: (turn: A2aTurn) => turn },
    )
    const result = await run(
      a2a_step({ id: 'ask', url: server.url }),
      { text: 'rate this', data: { stars: 4 } },
      QUIET,
    )
    expect(turns[0]).toMatchObject({ text: 'rate this', data: [{ stars: 4 }] })
    expect(result.data).toEqual([{ received: [{ stars: 4 }], said: 'rate this' }])
    expect(result.text).toBe('')
  })

  it('continues a conversation with context_id, so the remote flow sees the earlier exchange', async () => {
    const turns: A2aTurn[] = []
    const server = await serve(
      step('echo', (turn: A2aTurn) => {
        turns.push(turn)
        return `echo: ${turn.text}`
      }),
      { to_input: (turn: A2aTurn) => turn },
    )
    const ask = a2a_step({ id: 'ask', url: server.url })

    const first = await run(ask, 'one', QUIET)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await run(ask, { text: 'two', context_id: first.context_id }, QUIET)

    expect(second.context_id).toBe(first.context_id)
    expect(second.task_id).not.toBe(first.task_id)
    expect(turns[1]?.history).toEqual([
      { task_id: first.task_id, role: 'user', text: 'one' },
      { task_id: first.task_id, role: 'agent', text: 'echo: one' },
    ])
  })

  it('sends its headers with every request, the card included, and calls a function before each', async () => {
    const seen: Array<string | null> = []
    const server = await serve(step('echo', (text: string) => text), {
      authenticate: (request: Request) => {
        seen.push(request.headers.get('authorization'))
        return request.headers.get('authorization') === 'Bearer t2' ? { name: 'caller', authenticated: true } : null
      },
    })
    let token = 0
    const refreshing = a2a_step({
      id: 'ask',
      url: server.url,
      headers: async () => {
        token += 1
        return { authorization: `Bearer t${token}` }
      },
    })
    expect((await run(refreshing, 'hi', QUIET)).text).toBe('hi')
    expect(seen).toEqual(['Bearer t2'])

    const fixed = a2a_step({ id: 'ask', url: server.url, headers: { authorization: 'Bearer t2' } })
    expect((await run(fixed, 'again', QUIET)).text).toBe('again')

    const anonymous = a2a_step({ id: 'ask', url: server.url })
    await expect(run(anonymous, 'no token', QUIET)).rejects.toThrow(/401/)
  })

  it('reads the card once for each step value', async () => {
    const server = await serve(step('echo', (text: string) => text))
    const fetched: string[] = []
    const real_fetch = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      fetched.push(String(input instanceof Request ? input.url : input))
      return real_fetch(input, init)
    })
    try {
      const ask = a2a_step({ id: 'ask', url: server.url })
      await run(ask, 'one', QUIET)
      await run(ask, 'two', QUIET)
    } finally {
      spy.mockRestore()
    }
    expect(fetched.filter((url) => url.endsWith('/.well-known/agent-card.json'))).toHaveLength(1)
    expect(fetched).toHaveLength(3)
  })

  it('throws a2a_error with the state and the status text when the remote task fails', async () => {
    const server = await serve(
      step('boom', (): string => {
        throw new Error('the remote flow broke')
      }),
    )
    const err: unknown = await run(a2a_step({ id: 'ask', url: server.url }), 'go', QUIET).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(a2a_error)
    expect(err).toMatchObject({
      kind: 'a2a_error',
      state: 'TASK_STATE_FAILED',
      status_text: 'the remote flow broke',
    })
    const failure = err as a2a_error
    expect(failure.message).toBe(`the remote task ${failure.task_id} ended in TASK_STATE_FAILED: the remote flow broke`)
  })

  it('records each change of the remote status as an emit event', async () => {
    const server = await serve(
      step('boom', (): string => {
        throw new Error('the remote flow broke')
      }),
    )
    const { events, logger } = recorder()
    await run(a2a_step({ id: 'ask', url: server.url }), 'go', logger).catch(() => {})
    const emitted = events.filter((event) => event.kind === 'emit' && 'a2a_status' in event)
    expect(emitted).toMatchObject([
      { step_id: 'ask', a2a_status: { state: 'TASK_STATE_WORKING', text: '' } },
      { step_id: 'ask', a2a_status: { state: 'TASK_STATE_FAILED', text: 'the remote flow broke' } },
    ])
    const ids = emitted.map((event) => (event['a2a_status'] as { task_id: string }).task_id)
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(ids[1]).toBe(ids[0])
  })

  it('cancels the remote task when the run is aborted, then throws the abort reason', async () => {
    const { flow, latch } = latched()
    const server = await serve(flow)
    const abort = new AbortController()
    const reason = new Error('the caller gave up')
    const { events, logger } = recorder()
    const running = run(a2a_step({ id: 'ask', url: server.url }), 'go', { ...logger, abort: abort.signal })
    await latch.started
    // The step says which remote task it opened as soon as it knows.
    await vi.waitFor(() => {
      expect(events.find((event) => event.kind === 'emit')).toMatchObject({
        step_id: 'ask',
        a2a_task: { task_id: expect.any(String), context_id: expect.any(String) },
      })
    })

    abort.abort(reason)

    await expect(running).rejects.toBe(reason)
    await vi.waitFor(() => {
      expect(latch.aborted()).toMatchObject({ kind: 'aborted_error', message: 'the task was canceled' })
    })
  })

  it('polls a task that rests working until an outside event ends it', async () => {
    const server = await serve(gated_flow(), { gates: () => 'external' })
    const { events, logger } = recorder()
    const asking = run(a2a_step({ id: 'ask', url: server.url }), 'v1.2', logger)
    const at_the_gate = (event: TrajectoryEvent): boolean =>
      (event['a2a_status'] as { text?: string } | undefined)?.text?.startsWith('Waiting on "approve"') === true
    await vi.waitFor(() => {
      expect(events.some(at_the_gate)).toBe(true)
    })
    const emitted = events.find(at_the_gate) as unknown as { a2a_status: { task_id: string; state: string } }
    expect(emitted.a2a_status.state).toBe('TASK_STATE_WORKING')

    await server.resume(emitted.a2a_status.task_id, { approve: { approved: true } })

    expect((await asking).text).toBe('published: notes on v1.2 [approved]')
  })
})

describe('a remote question', () => {
  it('suspends the local run at a gate named for the step and the round, and completes on the answer', async () => {
    const drafts = { n: 0 }
    const server = await serve(gated_flow(drafts))
    const ask = a2a_step({ id: 'ask', url: server.url })
    const flow = sequence([ask, step('wrap', (result: A2aResult) => `remote said: ${result.text}`)])
    const runs = durable({ store: memory_store() })

    const waiting = await runs.start('local', flow, 'v1.2', QUIET)

    expect(waiting).toMatchObject({
      kind: 'suspended',
      id: 'ask_1',
      payload: {
        input: {
          kind: 'question',
          text: 'Waiting for input at "approve".',
          data: [{ input: 'notes on v1.2' }],
        },
      },
    })

    const done = await runs.resume('local', flow, { ask_1: { approved: true } }, QUIET)

    expect(done).toEqual({ kind: 'done', run_id: 'local', output: 'remote said: published: notes on v1.2 [approved]' })
    // One remote task took both messages: the draft ran once for each drive
    // of that task, and no second task was opened by the replay.
    expect(drafts.n).toBe(2)
  })

  it('does not send a round again when the local run replays', async () => {
    const opened: string[] = []
    const server = await serve(approval(), {
      to_input: (turn: A2aTurn) => {
        opened.push(turn.task_id)
        return turn.text
      },
    })
    const ask = a2a_step({ id: 'ask', url: server.url })
    const runs = durable({ store: memory_store() })

    await runs.start('local', ask, 'draft', QUIET)
    // Driving again with nothing new replays the step up to its gate.
    const again = await runs.resume('local', ask, {}, QUIET)
    expect(again).toMatchObject({ kind: 'suspended', id: 'ask_1' })
    expect(opened).toHaveLength(1)

    const done = await runs.resume('local', ask, { ask_1: { approved: false } }, QUIET)
    expect(done).toMatchObject({ kind: 'done', output: { text: 'draft [refused]' } })
    expect(opened).toHaveLength(1)
  })

  it('asks again at the next round when the remote agent refuses the answer', async () => {
    const server = await serve(approval())
    const ask = a2a_step({ id: 'ask', url: server.url })
    const runs = durable({ store: memory_store() })
    await runs.start('local', ask, 'draft', QUIET)

    const refused = await runs.resume('local', ask, { ask_1: 'maybe' }, QUIET)
    expect(refused).toMatchObject({ kind: 'suspended', id: 'ask_2' })
    const question = (refused as { payload: { input: { text: string } } }).payload.input
    expect(question.text).toMatch(/^The answer to "approve" was refused: /)

    const done = await runs.resume('local', ask, { ask_2: { approved: true } }, QUIET)
    expect(done).toMatchObject({ kind: 'done', output: { text: 'draft [approved]' } })
  })

  it('throws a2a_error that says what to do when the run has no checkpoint store', async () => {
    const server = await serve(approval())
    const err: unknown = await run(a2a_step({ id: 'ask', url: server.url }), 'draft', QUIET).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(a2a_error)
    expect(err).toMatchObject({ state: 'TASK_STATE_INPUT_REQUIRED', status_text: 'Waiting for input at "approve".' })
    expect((err as Error).message).toBe(
      'the remote agent asked a question ("Waiting for input at \\"approve\\".") and step "ask" has no checkpoint store to wait with: drive the flow with durable(), or pass checkpoint_store to run()',
    )
  })

  it('surfaces through an agent that calls another, all the way up, and the answer goes all the way down', async () => {
    const inner = await serve(gated_flow())
    const outer_flow = sequence([
      a2a_step({ id: 'ask', url: inner.url }),
      step('wrap', (result: A2aResult) => `the inner agent said: ${result.text}`),
    ])
    // The remote text is routed away from the artifact, so the artifact is
    // the outer flow's own output and not the text that streamed through.
    const outer = await serve(outer_flow, { stream: () => 'none' })
    const client = await new ClientFactory().createFromUrl(outer.url)

    const asked = await client.sendMessage(user_request('v1.2'))
    if ('messageId' in asked) throw new Error('expected a task')
    expect(asked.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
    expect(asked.status?.message?.metadata).toEqual({ fascicle: { gate: 'ask_1' } })

    const answered = await client.sendMessage({
      ...user_request('', asked.id, asked.contextId),
      message: {
        ...user_request('', asked.id, asked.contextId).message!,
        parts: [
          { content: { $case: 'data', value: { approved: true } }, metadata: undefined, filename: '', mediaType: 'application/json' },
        ],
      },
    })
    if ('messageId' in answered) throw new Error('expected a task')
    expect(answered.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(answered.artifacts.at(-1)?.parts[0]?.content).toEqual({
      $case: 'text',
      value: 'the inner agent said: published: notes on v1.2 [approved]',
    })
  })
})

describe('a chain of agents, streamed', () => {
  // The text of every artifact chunk a stream carried, in order.
  async function chunks_of(events: AsyncIterable<StreamResponse>): Promise<{ texts: string[]; last: TaskState | undefined; id: string; context_id: string }> {
    const texts: string[] = []
    let last: TaskState | undefined
    let id = ''
    let context_id = ''
    for await (const event of events) {
      const payload = event.payload
      if (payload?.$case === 'task') {
        id = payload.value.id
        context_id = payload.value.contextId
      }
      if (payload?.$case === 'statusUpdate') last = payload.value.status?.state
      if (payload?.$case === 'artifactUpdate') {
        texts.push((payload.value.artifact?.parts ?? []).map((part) => (part.content?.$case === 'text' ? part.content.value : '')).join(''))
      }
    }
    return { texts, last, id, context_id }
  }

  it('streams the remote text that follows an answered question, and not the text before it again', async () => {
    const inner = await serve(sequence([speaker('lead', ['L1 ', 'L2 ']), approval(), speaker('tail', ['F1 ', 'F2'])]))
    const outer = await serve(
      sequence([a2a_step({ id: 'ask', url: inner.url }), step('wrap', (result: A2aResult) => `wrapped: ${result.text}`)]),
    )
    const client = await new ClientFactory().createFromUrl(outer.url)

    const asked = await chunks_of(client.sendMessageStream(user_request('v1.2')))
    expect(asked.texts).toEqual(['L1 ', 'L2 '])
    expect(asked.last).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)

    const request = user_request('', asked.id, asked.context_id)
    const answered = await chunks_of(
      client.sendMessageStream({
        ...request,
        message: {
          ...request.message!,
          parts: [
            { content: { $case: 'data', value: { approved: true } }, metadata: undefined, filename: '', mediaType: 'application/json' },
          ],
        },
      }),
    )
    expect(answered.texts).toEqual(['F1 ', 'F2'])
    expect(answered.last).toBe(TaskState.TASK_STATE_COMPLETED)
  })
})

describe('serve_a2a', () => {
  it('answers 500 with a message, and no error field, when the handler throws', async () => {
    const server = await serve(step('echo', (text: string) => text), {
      authenticate: () => {
        throw new Error('the token service is down')
      },
    })
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }),
    })
    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({ message: 'internal error' })
  })
})

describe('a2a_step as a value', () => {
  it('is a step marked side_effect that names its remote, and holds its id to the step id rule', () => {
    const ask = a2a_step({ id: 'ask', url: 'http://127.0.0.1:1', name: 'Ask the notes agent', description: 'remote' })
    expect(ask).toMatchObject({
      id: 'ask',
      kind: 'step',
      meta: { side_effect: true, name: 'Ask the notes agent', description: 'remote' },
      config: { remote: 'a2a', url: 'http://127.0.0.1:1' },
    })
    expect(a2a_step({ id: 'plain', url: 'http://127.0.0.1:1' }).meta).toEqual({ side_effect: true })
    expect(() => a2a_step({ id: 'not an id', url: 'http://127.0.0.1:1' })).toThrow(
      'a2a_step id "not an id" is not a valid identifier',
    )
  })

  it('tries the connection again on the next run after one that failed', async () => {
    const port = await free_port()
    const ask = a2a_step({ id: 'ask', url: `http://127.0.0.1:${port}` })
    await expect(run(ask, 'hi', QUIET)).rejects.toThrow()

    const server = await serve_a2a({
      flow: step('echo', (text: string) => `echo: ${text}`),
      card: { ...CARD, url: `http://127.0.0.1:${port}/` },
      port,
    })
    servers.push(server)
    expect((await run(ask, 'hi', QUIET)).text).toBe('echo: hi')
  })
})
