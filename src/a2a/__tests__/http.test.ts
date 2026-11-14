import { afterEach, describe, expect, it, vi } from 'vitest'
import { step } from '#core'
import { a2a_agent } from '../a2a_agent.js'
import type { A2aAgent, A2aAgentConfig, A2aTurn } from '../types.js'
import { CARD, gated_flow, latched, speaker } from './support/flows.js'
import { call, get_task, rpc_request, send, state_of, stream, task_in, user_message } from './support/rpc.js'

type Json = Record<string, unknown>

const agents: A2aAgent[] = []

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()))
})

const echo = step('echo', (text: string) => `echo: ${text}`)

async function agent_for(config: Partial<A2aAgentConfig<string, string>> = {}): Promise<A2aAgent> {
  const agent = await a2a_agent({ flow: echo, card: CARD, ...config })
  agents.push(agent)
  return agent
}

// Name the caller from a header, the way a real hook would read a token.
function by_header(request: Request) {
  const name = request.headers.get('x-user')
  return name === null ? null : { name, authenticated: true }
}

const as = (name: string) => ({ headers: { 'x-user': name } })

describe('the agent card', () => {
  it('is served at the well-known path, with a short cache lifetime', async () => {
    const agent = await agent_for()
    const response = await agent.fetch(new Request('http://agent.test/.well-known/agent-card.json'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await response.json()).toEqual({
      name: 'release-notes',
      description: 'Drafts release notes and publishes them once they are approved.',
      version: '0.0.0',
      supportedInterfaces: [{ url: 'http://agent.test/', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/plain', 'application/json'],
      skills: [{ id: 'notes', name: 'Release notes', description: 'Drafts and publishes release notes.' }],
    })
  })

  it('advertises every field the config gives it, security schemes as given', async () => {
    const agent = await agent_for({
      card: {
        name: 'full',
        description: 'Every field.',
        version: '2.1.0',
        url: 'https://agents.example.test/full',
        provider: { organization: 'Example', url: 'https://example.test' },
        documentation_url: 'https://example.test/docs',
        icon_url: 'https://example.test/icon.png',
        input_modes: ['text/plain'],
        output_modes: ['application/json'],
        security_schemes: {
          bearer: { scheme: { $case: 'httpAuthSecurityScheme', value: { description: '', scheme: 'bearer', bearerFormat: 'JWT' } } },
        },
        security_requirements: [{ schemes: { bearer: { list: [] } } }],
        skills: [
          {
            id: 'notes',
            name: 'Notes',
            description: 'Writes notes.',
            tags: ['writing'],
            examples: ['Notes on v1.2'],
            input_modes: ['text/plain'],
            output_modes: ['text/markdown'],
          },
        ],
      },
    })
    expect(agent.card).toMatchObject({ version: '2.1.0', iconUrl: 'https://example.test/icon.png' })

    const body = (await (
      await agent.fetch(new Request('http://agent.test/.well-known/agent-card.json'))
    ).json()) as Json

    expect(body).toMatchObject({
      name: 'full',
      version: '2.1.0',
      supportedInterfaces: [{ url: 'https://agents.example.test/full', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      provider: { organization: 'Example', url: 'https://example.test' },
      documentationUrl: 'https://example.test/docs',
      iconUrl: 'https://example.test/icon.png',
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['application/json'],
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'bearer', bearerFormat: 'JWT' } } },
      skills: [
        {
          id: 'notes',
          tags: ['writing'],
          examples: ['Notes on v1.2'],
          inputModes: ['text/plain'],
          outputModes: ['text/markdown'],
        },
      ],
    })
    expect(body['securityRequirements']).toHaveLength(1)
  })

  it('answers 405 to anything but GET, and stays public behind an authenticate hook', async () => {
    const agent = await agent_for({ authenticate: by_header })
    const posted = await agent.fetch(new Request('http://agent.test/.well-known/agent-card.json', { method: 'POST' }))
    expect(posted.status).toBe(405)
    expect(posted.headers.get('allow')).toBe('GET')
    expect(await posted.json()).toEqual({ message: 'the agent card takes GET' })
    expect((await agent.fetch(new Request('http://agent.test/.well-known/agent-card.json'))).status).toBe(200)
  })
})

describe('paths and methods', () => {
  it('answers 404 for a path it does not serve, and 405 for a GET on the JSON-RPC path', async () => {
    const agent = await agent_for()
    const missing = await agent.fetch(new Request('http://agent.test/elsewhere', { method: 'POST' }))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ message: 'nothing is served at /elsewhere' })

    const got = await agent.fetch(new Request('http://agent.test/'))
    expect(got.status).toBe(405)
    expect(got.headers.get('allow')).toBe('POST')
    expect(await got.json()).toEqual({ message: 'JSON-RPC takes POST' })
  })

  it('takes JSON-RPC at rpc_path when one is set, and no longer at the root', async () => {
    const agent = await agent_for({ rpc_path: '/a2a' })
    expect(state_of(await send(agent, 'hi', { path: '/a2a' }))).toBe('TASK_STATE_COMPLETED')
    const root = await agent.fetch(rpc_request('SendMessage', { message: user_message('hi') }))
    expect(root.status).toBe(404)
  })
})

describe('requests the handler refuses outside JSON-RPC', () => {
  it('answers 401 to a caller authenticate refuses, and runs nothing', async () => {
    const ran = { n: 0 }
    const agent = await agent_for({
      flow: step('count', (text: string) => {
        ran.n += 1
        return text
      }),
      authenticate: by_header,
    })
    const response = await agent.fetch(rpc_request('SendMessage', { message: user_message('hi') }))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ message: 'unauthorized' })
    expect(ran.n).toBe(0)
  })

  it('awaits an authenticate hook that answers later', async () => {
    const agent = await agent_for({
      authenticate: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return by_header(request)
      },
    })
    expect((await agent.fetch(rpc_request('SendMessage', { message: user_message('hi') }))).status).toBe(401)
    expect(state_of(await send(agent, 'hi', as('ann')))).toBe('TASK_STATE_COMPLETED')
  })

  it('answers 413 to a body over max_body_bytes, by its declared length or by what arrives', async () => {
    const agent = await agent_for({ max_body_bytes: 200 })
    const big = user_message('x'.repeat(500))

    const declared = await agent.fetch(rpc_request('SendMessage', { message: big }, { headers: { 'content-length': '900' } }))
    expect(declared.status).toBe(413)
    expect(await declared.json()).toEqual({ message: 'the request body is over 200 bytes' })

    const body = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: big } }))
    const chunked = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(body.slice(0, 150))
        controller.enqueue(body.slice(150))
        controller.close()
      },
    })
    const streamed = await agent.fetch(
      new Request('http://agent.test/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
        body: chunked,
        duplex: 'half',
      }),
    )
    expect(streamed.status).toBe(413)

    const small = await agent_for({ max_body_bytes: 2_000 })
    expect(state_of(await send(small, 'fits'))).toBe('TASK_STATE_COMPLETED')
  })

  it('takes a body of exactly max_body_bytes', async () => {
    const text = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: user_message('hi') } })
    const size = new TextEncoder().encode(text).byteLength
    const post = (): Request =>
      new Request('http://agent.test/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
        body: text,
      })
    const exact = await agent_for({ max_body_bytes: size })
    expect((await exact.fetch(post())).status).toBe(200)
    const one_short = await agent_for({ max_body_bytes: size - 1 })
    expect((await one_short.fetch(post())).status).toBe(413)
  })

  it('answers 429 with retry-after to a new task while max_drives drives are running', async () => {
    const { flow, latch } = latched()
    const agent = await agent_for({ flow, max_drives: 1 })
    const first = await call(agent, 'SendMessage', {
      message: user_message('one'),
      configuration: { returnImmediately: true },
    })
    await latch.started

    const second = await agent.fetch(rpc_request('SendMessage', { message: user_message('two') }))
    expect(second.status).toBe(429)
    expect(second.headers.get('retry-after')).toBe('1')
    expect(await second.json()).toEqual({
      message: 'the agent is running as many tasks as it takes at once: try again shortly',
    })
    const streamed = await agent.fetch(rpc_request('SendStreamingMessage', { message: user_message('three') }))
    expect(streamed.status).toBe(429)

    // Reading a task, or anything that starts none, still gets through.
    const task_id = task_in(first)['id'] as string
    expect(state_of(await get_task(agent, task_id))).toBe('TASK_STATE_WORKING')

    latch.open()
    await vi.waitFor(async () => {
      expect(state_of(await get_task(agent, task_id))).toBe('TASK_STATE_COMPLETED')
    })
    expect(state_of(await send(agent, 'now there is room'))).toBe('TASK_STATE_COMPLETED')
  })

  it('lets an answer to a waiting task through at capacity, since it starts no task', async () => {
    const waiting_agent = await a2a_agent({ flow: gated_flow(), card: CARD, max_drives: 0 })
    agents.push(waiting_agent)
    const refused = await waiting_agent.fetch(rpc_request('SendMessage', { message: user_message('v1') }))
    expect(refused.status).toBe(429)
    const answer = await waiting_agent.fetch(
      rpc_request('SendMessage', { message: user_message('', { task_id: 'some-task', data: { approved: true } }) }),
    )
    expect(answer.status).toBe(200)
    expect(await answer.json()).toMatchObject({ error: { code: -32001 } })
  })
})

describe('JSON-RPC errors', () => {
  it('refuses A2A-Version 0.3, and a request with no version header, which means 0.3', async () => {
    const agent = await agent_for()
    const old = await call(agent, 'SendMessage', { message: user_message('hi') }, { headers: { 'a2a-version': '0.3' } })
    expect(old.status).toBe(200)
    expect(old.error).toMatchObject({ code: -32009 })
    expect(String(old.error?.['message'])).toContain("'0.3' is not supported. Supported versions: 1.0")

    const bare = await agent.fetch(
      new Request('http://agent.test/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'abc', method: 'GetTask', params: { id: 'x' } }),
      }),
    )
    expect(await bare.json()).toMatchObject({ jsonrpc: '2.0', id: 'abc', error: { code: -32009 } })
  })

  it('answers a parse error for a body that is not JSON', async () => {
    const agent = await agent_for()
    const response = await agent.fetch(
      new Request('http://agent.test/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
        body: '{ "jsonrpc": ',
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Invalid JSON payload.' },
    })
  })

  it('refuses a content type other than JSON, and takes one with a charset', async () => {
    const agent = await agent_for()
    const text = await agent.fetch(
      new Request('http://agent.test/', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'a2a-version': '1.0' },
        body: '{}',
      }),
    )
    expect(await text.json()).toMatchObject({
      id: null,
      error: { code: -32005, message: 'Unsupported Content-Type "text/plain"; expected application/json.' },
    })
    const with_charset = await send(agent, 'hi', { headers: { 'content-type': 'Application/JSON; charset=utf-8' } })
    expect(state_of(with_charset)).toBe('TASK_STATE_COMPLETED')
  })

  it('answers method-not-found for a method the protocol does not have', async () => {
    const agent = await agent_for()
    const { status, error } = await call(agent, 'tasks/get', { id: 'x' })
    expect(status).toBe(200)
    expect(error).toMatchObject({ code: -32601 })
  })

  it('answers TaskNotFound for a task nobody has, and refuses push notification configs', async () => {
    const agent = await agent_for()
    expect((await call(agent, 'GetTask', { id: 'missing' })).error).toMatchObject({ code: -32001 })
    const push = await call(agent, 'ListTaskPushNotificationConfigs', { taskId: 'missing' })
    expect(push.error).toMatchObject({ code: -32003 })
  })
})

describe('callers', () => {
  it('reaches the flow as turn.user, and keeps one caller from getting or listing another\'s task', async () => {
    const turns: A2aTurn[] = []
    const agent = await a2a_agent({
      flow: echo,
      card: CARD,
      authenticate: by_header,
      to_input: (turn) => {
        turns.push(turn)
        return turn.text
      },
    })
    agents.push(agent)

    const task = await send(agent, 'mine', as('ann'))
    expect(turns[0]?.user).toEqual({ name: 'ann', authenticated: true })

    expect((await call(agent, 'GetTask', { id: task['id'] }, as('bob'))).error).toMatchObject({ code: -32001 })
    expect((await call(agent, 'CancelTask', { id: task['id'] }, as('bob'))).error).toMatchObject({ code: -32001 })
    const bobs = await call(agent, 'ListTasks', {}, as('bob'))
    expect(bobs.result).toMatchObject({ tasks: [], totalSize: 0 })

    const anns = await call(agent, 'ListTasks', {}, as('ann'))
    expect(((anns.result?.['tasks'] ?? []) as Json[]).map((listed) => listed['id'])).toEqual([task['id']])
    expect(state_of(await get_task(agent, task['id'] as string, as('ann')))).toBe('TASK_STATE_COMPLETED')
  })

  it('resumes an authenticated caller\'s task for the caller it last saw it under, or the one it is told', async () => {
    const config = {
      flow: gated_flow(),
      card: CARD,
      authenticate: by_header,
      gates: () => 'external' as const,
    }
    const agent = await a2a_agent(config)
    agents.push(agent)
    const seen = await send(agent, 'v1', as('ann'))
    await agent.resume(seen['id'] as string, { approve: { approved: true } })
    expect(state_of(await get_task(agent, seen['id'] as string, as('ann')))).toBe('TASK_STATE_COMPLETED')

    const told = await send(agent, 'v2', as('ann'))
    await expect(
      agent.resume(told['id'] as string, { approve: { approved: true } }, { user: { name: 'bob', authenticated: true } }),
    ).rejects.toMatchObject({ kind: 'a2a_error' })
    await agent.resume(told['id'] as string, { approve: { approved: true } }, { user: { name: 'ann', authenticated: true } })
    expect(state_of(await get_task(agent, told['id'] as string, as('ann')))).toBe('TASK_STATE_COMPLETED')
  })
})

describe('streams', () => {
  it('keeps recording a task whose client stopped reading its stream', async () => {
    const { flow, latch } = latched()
    const agent = await agent_for({ flow })
    const response = await agent.fetch(rpc_request('SendStreamingMessage', { message: user_message('go') }))
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body?.getReader()
    const first = await reader?.read()
    const frame = JSON.parse(new TextDecoder().decode(first?.value).split('data: ')[1] ?? '') as {
      result: { task: Json }
    }
    const task_id = frame.result.task['id'] as string
    await latch.started

    await reader?.cancel()
    expect(state_of(await get_task(agent, task_id))).toBe('TASK_STATE_WORKING')
    latch.open('after the client left')

    await vi.waitFor(async () => {
      expect(state_of(await get_task(agent, task_id))).toBe('TASK_STATE_COMPLETED')
    })
  })

  it('lets a client subscribe to a working task and read it to the end', async () => {
    const { flow, latch } = latched()
    const agent = await agent_for({ flow })
    const started = await call(agent, 'SendMessage', {
      message: user_message('go'),
      configuration: { returnImmediately: true },
    })
    const task_id = task_in(started)['id'] as string
    await latch.started

    const reading = stream(agent, 'SubscribeToTask', { id: task_id })
    await new Promise((resolve) => setTimeout(resolve, 10))
    latch.open('seen by the subscriber')
    const frames = await reading

    expect(Object.keys(frames[0] ?? {})).toEqual(['task'])
    expect(state_of(frames.at(-1)?.['statusUpdate'] as Json)).toBe('TASK_STATE_COMPLETED')
  })

  it('answers a stream that fails before it starts as a plain JSON-RPC error', async () => {
    const agent = await agent_for()
    const response = await agent.fetch(rpc_request('SubscribeToTask', { id: 'missing' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toMatchObject({ error: { code: -32001 } })
  })

  it('sends server-sent event headers, and one data frame for each response', async () => {
    const agent = await agent_for({ flow: speaker('write', ['a', 'b']) })
    const response = await agent.fetch(rpc_request('SendStreamingMessage', { message: user_message('go') }))
    expect(response.headers.get('cache-control')).toBe('no-cache')
    const text = await response.text()
    const frames = text.split('\n\n').filter((block) => block !== '')
    expect(frames).toHaveLength(5)
    for (const frame of frames) {
      expect(frame.startsWith('data: ')).toBe(true)
      expect(JSON.parse(frame.slice('data: '.length))).toMatchObject({ jsonrpc: '2.0' })
    }
  })
})
