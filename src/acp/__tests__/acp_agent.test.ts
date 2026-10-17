import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { client, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk'
import { model_step } from 'fascicle'
import { sequence, step } from '#core'
import type { RunContext, TrajectoryEvent, TrajectoryLogger } from '#core'
import { make_stub_engine } from '#testing'
import { acp_agent } from '../acp_agent.js'
import { to_session_updates } from '../to_session_updates.js'
import { connect_client, open_session, read_turn, read_until } from '../test/connect_client.js'
import type { AcpHistoryEntry, AcpSession, AcpTurn, ServeAcpConfig } from '../types.js'

/** A model call that streams `content` as one text chunk and returns it. */
function reply_step(content = 'hello there', id = 'reply') {
  return model_step({ engine: make_stub_engine([{ prefix: '', content }]), model: 'stub-model', id })
}

function until_aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function message(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
}

function thought(text: string): SessionUpdate {
  return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }
}

function is_message(update: SessionUpdate): boolean {
  return update.sessionUpdate === 'agent_message_chunk'
}

/** Record a model chunk the way model_call does, for a flow that streams after its model call. */
function stream_text(ctx: RunContext, text: string): void {
  ctx.trajectory.record({ kind: 'model_chunk', step_id: 'late', chunk: { kind: 'text', text, step_index: 0 } })
}

/**
 * A flow that streams `partial`, then waits for the turn's abort. It throws
 * the abort's reason unless `ignore_abort`, in which case it streams `late`
 * and finishes anyway.
 */
function stalled_reply(options: { ignore_abort?: boolean } = {}) {
  const seen = { aborted: false, finished: false }
  const flow = sequence([
    reply_step('partial'),
    step('stall', async (_: string, ctx) => {
      await until_aborted(ctx.abort)
      seen.aborted = true
      if (options.ignore_abort !== true) throw ctx.abort.reason
      stream_text(ctx, 'late')
      seen.finished = true
      return 'finished anyway'
    }),
  ])
  return { flow, seen }
}

/**
 * A flow over the turn that, on its first call, stalls until aborted (after
 * streaming `partial` when `reply_first`) and later reports the history it
 * was handed. It records why it was aborted, and with `ignore_abort` it
 * finishes anyway instead of throwing.
 */
function history_probe(options: { reply_first: boolean; ignore_abort?: boolean }) {
  const started = Promise.withResolvers<void>()
  const histories: AcpHistoryEntry[][] = []
  const reasons: string[] = []
  const flow = step('probe', async (turn: AcpTurn, ctx) => {
    histories.push(structuredClone([...turn.history]))
    if (histories.length > 1) return 'done'
    if (options.reply_first) stream_text(ctx, 'partial')
    started.resolve()
    await until_aborted(ctx.abort)
    reasons.push(ctx.abort.reason instanceof Error ? ctx.abort.reason.message : String(ctx.abort.reason))
    if (options.ignore_abort === true) return 'finished anyway'
    throw ctx.abort.reason
  })
  return { flow, started: started.promise, histories, reasons }
}

const card: SessionUpdate = {
  sessionUpdate: 'tool_call',
  toolCallId: 'card-1',
  title: 'Run the tests',
  kind: 'execute',
  status: 'pending',
}

const card_progress: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'card-1', status: 'completed' }

const picture: SessionUpdate = {
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
}

/**
 * Run a turn whose flow sends `updates` in order, then a second turn, and
 * return what the client was sent for the first along with the reply text
 * the second turn's history holds for it.
 */
async function recorded_reply(
  updates: ReadonlyArray<SessionUpdate>,
): Promise<{ sent: ReadonlyArray<SessionUpdate>; recorded: string | undefined }> {
  const histories: AcpHistoryEntry[][] = []
  const app = await acp_agent({
    name: 'test-agent',
    flow: step('sender', (turn: AcpTurn, ctx) => {
      histories.push(structuredClone([...turn.history]))
      if (histories.length === 1) updates.forEach((_, index) => ctx.emit({ index }))
      return ''
    }),
    to_input: (turn) => turn,
    to_updates: (event) => {
      const update = event.kind === 'emit' ? updates[Number(event['index'])] : undefined
      return update === undefined ? [] : [update]
    },
  })
  const { session } = await open_session(app)
  await session.prompt('go')
  const first = await read_turn(session)
  await session.prompt('again')
  await read_turn(session)
  return { sent: first.updates, recorded: histories[1]?.[1]?.text }
}

const scratch_dirs: string[] = []

/** A fresh directory under the system's temp directory, removed after the suite. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-agent-'))
  scratch_dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await Promise.all(scratch_dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('acp_agent: initialize and sessions', () => {
  it('answers initialize with the protocol version, its name and version, and its capabilities', async () => {
    const app = await acp_agent({ name: 'test-agent', version: '1.2.3', flow: step('noop', () => '') })
    const { agent } = connect_client(app)
    const response = await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(response).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'test-agent', version: '1.2.3' },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { embeddedContext: true },
        sessionCapabilities: { additionalDirectories: {} },
      },
      authMethods: [],
    })
  })

  it('reports version 0.0.0 when the config names none', async () => {
    const app = await acp_agent({ name: 'test-agent', flow: step('noop', () => '') })
    const { agent } = connect_client(app)
    const response = await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION })
    expect(response.agentInfo).toEqual({ name: 'test-agent', version: '0.0.0' })
  })

  it('answers authenticate with an empty result', async () => {
    const app = await acp_agent({ name: 'test-agent', flow: step('noop', () => '') })
    const { agent } = connect_client(app)
    await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION })
    await expect(agent.request('authenticate', { methodId: 'none' })).resolves.toEqual({})
  })

  it('accepts mcpServers on session/new and ignores them', async () => {
    const app = await acp_agent({ name: 'test-agent', flow: reply_step() })
    const { session } = await open_session(app, {
      session: { mcpServers: [{ name: 'files', command: '/bin/mcp-files', args: [], env: [] }] },
    })
    await session.prompt('hi')
    expect(await read_turn(session)).toEqual({ updates: [message('hello there')], stop_reason: 'end_turn' })
  })

  it('builds a flow function once per session, handing it the session it serves', async () => {
    const built: AcpSession[] = []
    const app = await acp_agent({
      name: 'test-agent',
      flow: (session) => {
        built.push(session)
        return reply_step()
      },
    })
    const [a, b] = await Promise.all([scratch(), scratch()])
    const first = await open_session(app, { client_capabilities: { terminal: true }, session: { cwd: a } })
    await first.session.prompt('one')
    await first.session.prompt('two')
    const second = await open_session(app, { session: { cwd: b } })
    expect(built).toHaveLength(2)
    expect(built[0]).toMatchObject({ id: first.session.sessionId, cwd: a, client_capabilities: { terminal: true } })
    expect(built[1]).toMatchObject({ id: second.session.sessionId, cwd: b })
    expect(built[1]?.client_capabilities.terminal).not.toBe(true)
  })

  it("fails session/new with the builder's own message when building the flow throws", async () => {
    const app = await acp_agent({
      name: 'test-agent',
      flow: () => {
        throw new Error('no flow for this workspace')
      },
    })
    const { agent } = connect_client(app)
    await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION })
    const failure = agent.request('session/new', { cwd: tmpdir(), mcpServers: [] })
    await expect(failure).rejects.toBeInstanceOf(RequestError)
    await expect(failure).rejects.toThrow('Internal error: no flow for this workspace')
  })
})

describe('acp_agent: workspace roots', () => {
  /** An agent whose flow builder records each session it's handed. */
  async function recording_agent() {
    const built: AcpSession[] = []
    const app = await acp_agent({
      name: 'test-agent',
      flow: (session) => {
        built.push(session)
        return reply_step()
      },
    })
    const { agent } = connect_client(app)
    await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION })
    return { agent, built }
  }

  it('hands the flow the roots as the client sent them and as real paths, a cwd behind a symlink included', async () => {
    const base = await scratch()
    await Promise.all([mkdir(join(base, 'project')), mkdir(join(base, 'shared'))])
    await symlink(join(base, 'project'), join(base, 'via'))
    const { agent, built } = await recording_agent()
    await agent.request('session/new', {
      cwd: join(base, 'via'),
      additionalDirectories: [join(base, 'shared')],
      mcpServers: [],
    })
    // tmpdir() itself sits behind a symlink on macOS, so the real roots differ from base twice over.
    const real_base = await realpath(base)
    expect(built).toEqual([
      expect.objectContaining({
        cwd: join(base, 'via'),
        additional_directories: [join(base, 'shared')],
        roots: [join(real_base, 'project'), join(real_base, 'shared')],
      }),
    ])
  })

  it('gives a session with no additional directories its cwd alone as a root', async () => {
    const cwd = await scratch()
    const { agent, built } = await recording_agent()
    await agent.request('session/new', { cwd, mcpServers: [] })
    expect(built[0]?.additional_directories).toEqual([])
    expect(built[0]?.roots).toEqual([await realpath(cwd)])
  })

  it('fails session/new with invalid params naming a cwd that does not exist, and builds no flow', async () => {
    const missing = join(await scratch(), 'missing')
    const { agent, built } = await recording_agent()
    await expect(agent.request('session/new', { cwd: missing, mcpServers: [] })).rejects.toMatchObject({
      code: -32602,
      message: `Invalid params: the workspace root ${missing} can't be opened (ENOENT); send session/new with a directory that exists`,
      data: { cwd: missing, additionalDirectories: [] },
    })
    expect(built).toEqual([])
  })

  it('fails session/new naming an additional directory that does not exist', async () => {
    const cwd = await scratch()
    const missing = join(cwd, 'gone')
    const { agent } = await recording_agent()
    await expect(
      agent.request('session/new', { cwd, additionalDirectories: [missing], mcpServers: [] }),
    ).rejects.toMatchObject({
      message: `Invalid params: the workspace root ${missing} can't be opened (ENOENT); send session/new with a directory that exists`,
      data: { cwd, additionalDirectories: [missing] },
    })
  })

  it('refuses a relative root, which would resolve against wherever the agent was launched', async () => {
    const { agent } = await recording_agent()
    await expect(agent.request('session/new', { cwd: 'src', mcpServers: [] })).rejects.toMatchObject({
      message: 'Invalid params: the workspace root src is a relative path; send session/new with absolute paths',
    })
  })

  it('refuses a file as a root', async () => {
    const file = join(await scratch(), 'notes.txt')
    await writeFile(file, 'not a directory')
    const { agent } = await recording_agent()
    await expect(agent.request('session/new', { cwd: file, mcpServers: [] })).rejects.toMatchObject({
      message: `Invalid params: the workspace root ${file} is a file; send session/new with a directory`,
    })
  })
})

describe('acp_agent: prompt turns', () => {
  it("ends the turn with the model's streamed text and sends no second message", async () => {
    const app = await acp_agent({ name: 'test-agent', flow: reply_step('hello there') })
    const { session } = await open_session(app)
    await expect(session.prompt('hi')).resolves.toEqual({ stopReason: 'end_turn' })
    expect(await read_turn(session)).toEqual({ updates: [message('hello there')], stop_reason: 'end_turn' })
  })

  it("sends to_text's text when the flow streamed no message", async () => {
    const app = await acp_agent({
      name: 'test-agent',
      flow: step('answer', () => ({ answer: 42 })),
      to_text: (output) => `the answer is ${output.answer}`,
    })
    const { session } = await open_session(app)
    await session.prompt('what is it?')
    expect(await read_turn(session)).toEqual({ updates: [message('the answer is 42')], stop_reason: 'end_turn' })
  })

  it.each<[string, unknown, string]>([
    ['a string as-is', 'plain words', 'plain words'],
    ['an object as JSON', { a: 1, b: ['x'] }, '{"a":1,"b":["x"]}'],
  ])('sends %s by default', async (_, output, expected) => {
    const app = await acp_agent({ name: 'test-agent', flow: step('out', () => output) })
    const { session } = await open_session(app)
    await session.prompt('go')
    expect(await read_turn(session)).toEqual({ updates: [message(expected)], stop_reason: 'end_turn' })
  })

  it('sends the to_text message after a flow whose text all routes to thought', async () => {
    const app = await acp_agent({ name: 'test-agent', flow: reply_step('draft'), stream: () => 'thought' })
    const { session } = await open_session(app)
    await session.prompt('think')
    expect(await read_turn(session)).toEqual({ updates: [thought('draft'), message('draft')], stop_reason: 'end_turn' })
  })

  it('routes model text by step_id through stream', async () => {
    const routed: string[] = []
    const app = await acp_agent({
      name: 'test-agent',
      flow: sequence([reply_step('draft', 'draft'), reply_step('final', 'final')]),
      stream: (step_id) => {
        routed.push(step_id)
        return step_id === 'draft' ? 'none' : 'message'
      },
    })
    const { session } = await open_session(app)
    await session.prompt('write')
    expect(await read_turn(session)).toEqual({ updates: [message('final')], stop_reason: 'end_turn' })
    expect(routed).toEqual(['draft', 'final'])
  })

  it('sends no message for a flow that returns nothing', async () => {
    const app = await acp_agent({ name: 'test-agent', flow: step('quiet', () => undefined) })
    const { session } = await open_session(app)
    await session.prompt('hush')
    expect(await read_turn(session)).toEqual({ updates: [], stop_reason: 'end_turn' })
  })

  it('counts a message from a custom to_updates as the reply', async () => {
    const app = await acp_agent({
      name: 'test-agent',
      flow: step('emitter', (_: string, ctx) => {
        ctx.emit({ say: 'from an emit' })
        return 'the output'
      }),
      to_updates: (event) => (event.kind === 'emit' ? [message(String(event['say']))] : []),
    })
    const { session } = await open_session(app)
    await session.prompt('go')
    expect(await read_turn(session)).toEqual({ updates: [message('from an emit')], stop_reason: 'end_turn' })
  })

  it('counts a message without text as a reply that adds no history', async () => {
    const image: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    }
    const histories: AcpHistoryEntry[][] = []
    const app = await acp_agent({
      name: 'test-agent',
      flow: step('pictures', (turn: AcpTurn, ctx) => {
        histories.push([...turn.history])
        ctx.emit({ picture: true })
        return 'the output'
      }),
      to_input: (turn) => turn,
      to_updates: (event) => (event.kind === 'emit' ? [image] : []),
    })
    const { session } = await open_session(app)
    await session.prompt('draw')
    expect(await read_turn(session)).toEqual({ updates: [image], stop_reason: 'end_turn' })
    await session.prompt('again')
    await read_turn(session)
    expect(histories[1]).toEqual([{ role: 'user', text: 'draw' }])
  })

  it('records the reply text after a tool card on a blank line, and sends the client the same updates', async () => {
    const updates = [message('Running the tests.'), card, card_progress, message('All pass.')]
    const { sent, recorded } = await recorded_reply(updates)
    expect(sent).toEqual(updates)
    expect(recorded).toBe('Running the tests.\n\nAll pass.')
  })

  it('records chunks with no card between them joined, as before', async () => {
    const { recorded } = await recorded_reply([message('one '), message('two')])
    expect(recorded).toBe('one two')
  })

  it.each([
    ['a card before any reply text adds no leading gap', [card, message('hi')], 'hi'],
    ['a card with no text after it adds no trailing gap', [message('a'), card], 'a'],
    ['cards in a row add one gap', [message('a'), card, card, message('b')], 'a\n\nb'],
    ['every run after a card starts on its own line', [message('a'), card, message('b'), card, message('c')], 'a\n\nb\n\nc'],
    ['a card update without a new card adds no gap', [message('a'), card_progress, message('b')], 'ab'],
    ['an empty chunk after a card adds no trailing gap', [message('a'), card, message('')], 'a'],
    ['a picture leaves the gap for the next text', [message('a'), card, picture, message('b')], 'a\n\nb'],
  ] as const)('%s', async (_name, updates, expected) => {
    const { recorded } = await recorded_reply(updates)
    expect(recorded).toBe(expected)
  })

  it('hands the flow its turn: the session id, the cwd, the text, and the raw prompt', async () => {
    const turns: AcpTurn[] = []
    const app = await acp_agent({
      name: 'test-agent',
      flow: step('capture', (turn: AcpTurn) => {
        turns.push(turn)
        return 'ok'
      }),
      to_input: (turn) => turn,
    })
    const cwd = await scratch()
    const { session } = await open_session(app, { session: { cwd } })
    const prompt: ContentBlock[] = [
      { type: 'text', text: 'one ' },
      { type: 'text', text: 'two' },
    ]
    await session.prompt(prompt)
    expect(turns[0]).toEqual({ session_id: session.sessionId, cwd, text: 'one two', prompt, history: [] })
  })

  it('writes a resource link as its URI and inlines an embedded resource after the prompt', async () => {
    const texts: string[] = []
    const app = await acp_agent({
      name: 'test-agent',
      flow: step('capture', (text: string) => {
        texts.push(text)
        return 'ok'
      }),
    })
    const { session } = await open_session(app)
    await session.prompt([
      { type: 'text', text: 'compare ' },
      { type: 'resource_link', uri: 'file:///workspace/a.ts', name: 'a.ts' },
      { type: 'text', text: ' with ' },
      { type: 'resource', resource: { uri: 'file:///workspace/b.ts', text: 'export const b = 1' } },
      { type: 'text', text: ' and ' },
      { type: 'resource', resource: { uri: 'file:///workspace/logo.png', blob: 'iVBORw0KGgo=' } },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
    expect(texts[0]).toBe(
      'compare file:///workspace/a.ts with file:///workspace/b.ts and file:///workspace/logo.png\n\n' +
        '<context ref="file:///workspace/b.ts">\nexport const b = 1\n</context>',
    )
  })

  it('hands each turn a copy of the history, holding what the client was sent', async () => {
    const histories: AcpHistoryEntry[][] = []
    const config: ServeAcpConfig<AcpTurn, string> = {
      name: 'test-agent',
      flow: step('echo', (turn: AcpTurn) => {
        histories.push(structuredClone([...turn.history]))
        // A flow that writes to its copy must not reach the session's history.
        const copy = turn.history as AcpHistoryEntry[]
        copy.push({ role: 'user', text: 'smuggled' })
        return `reply ${histories.length}`
      }),
      to_input: (turn) => turn,
    }
    const app = await acp_agent(config)
    const { session } = await open_session(app)
    await session.prompt('one')
    await session.prompt('two')
    expect(histories).toEqual([
      [],
      [
        { role: 'user', text: 'one' },
        { role: 'agent', text: 'reply 1' },
      ],
    ])
  })

  it("fails the prompt with the flow's own message, and leaves the failed turn out of the history", async () => {
    let calls = 0
    const histories: AcpHistoryEntry[][] = []
    const app = await acp_agent({
      name: 'test-agent',
      flow: step('flaky', (turn: AcpTurn) => {
        calls += 1
        histories.push([...turn.history])
        if (calls === 1) throw new Error('the model provider is down')
        return 'fine now'
      }),
      to_input: (turn) => turn,
    })
    const { session } = await open_session(app)
    const failure = session.prompt('first')
    await expect(failure).rejects.toBeInstanceOf(RequestError)
    await expect(failure).rejects.toThrow('Internal error: the model provider is down')
    await session.prompt('second')
    expect(histories[1]).toEqual([])
  })

  it('names a thrown value that is not an Error', async () => {
    const app = await acp_agent({
      name: 'test-agent',
      flow: step('odd', () => {
        // oxlint-disable-next-line no-throw-literal
        throw 'a bare string'
      }),
    })
    const { session } = await open_session(app)
    await expect(session.prompt('go')).rejects.toThrow('Internal error: a bare string')
  })

  it('fails a prompt for an unknown session with a message naming it', async () => {
    const app = await acp_agent({ name: 'test-agent', flow: reply_step() })
    const { agent } = connect_client(app)
    await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION })
    const failure = agent.request('session/prompt', { sessionId: 'nope', prompt: [{ type: 'text', text: 'hi' }] })
    await expect(failure).rejects.toMatchObject({
      code: -32602,
      message: 'Invalid params: unknown session nope; start one with session/new first',
      data: { sessionId: 'nope' },
    })
  })

  it('writes a warning to stderr when the run drops events the client fell behind on', async () => {
    const writes: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    })
    const app = await acp_agent({
      name: 'test-agent',
      flow: step('flood', (_: string, ctx) => {
        for (let i = 0; i < 10_050; i += 1) ctx.emit({ i })
        return 'done'
      }),
    })
    const { session } = await open_session(app)
    await session.prompt('go')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(/^fascicle\/acp: .* so \d+ run events were dropped and the reply is missing text/)
  })
})

describe('acp_agent: cancellation', () => {
  it('answers cancelled when the client cancels mid-reply, and sends nothing after', async () => {
    const { flow, seen } = stalled_reply()
    const app = await acp_agent({ name: 'test-agent', flow })
    const { agent, session } = await open_session(app)
    const response = session.prompt('go')
    expect(await read_until(session, is_message)).toEqual([message('partial')])
    await agent.notify('session/cancel', { sessionId: session.sessionId })
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' })
    expect(await read_turn(session)).toEqual({ updates: [], stop_reason: 'cancelled' })
    expect(seen.aborted).toBe(true)
  })

  it('answers cancelled when the flow ignores the abort and finishes, sending none of what came after', async () => {
    const { flow, seen } = stalled_reply({ ignore_abort: true })
    const app = await acp_agent({ name: 'test-agent', flow })
    const { agent, session } = await open_session(app)
    const response = session.prompt('go')
    await read_until(session, is_message)
    await agent.notify('session/cancel', { sessionId: session.sessionId })
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' })
    expect(await read_turn(session)).toEqual({ updates: [], stop_reason: 'cancelled' })
    expect(seen.finished).toBe(true)
  })

  it("records only the user's text, marked cancelled, for a turn cancelled before any reply", async () => {
    const { flow, started, histories, reasons } = history_probe({ reply_first: false })
    const app = await acp_agent({ name: 'test-agent', flow, to_input: (turn) => turn })
    const { agent, session } = await open_session(app)
    const response = session.prompt('first')
    await started
    await agent.notify('session/cancel', { sessionId: session.sessionId })
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' })
    await session.prompt('second')
    expect(histories[1]).toEqual([{ role: 'user', text: 'first', cancelled: true }])
    expect(reasons).toEqual(['the ACP client cancelled the turn'])
  })

  it('sends no to_text message for a cancelled turn whose flow finished without a reply', async () => {
    const { flow, started, histories } = history_probe({ reply_first: false, ignore_abort: true })
    const app = await acp_agent({ name: 'test-agent', flow, to_input: (turn) => turn })
    const { agent, session } = await open_session(app)
    const response = session.prompt('first')
    await started
    await agent.notify('session/cancel', { sessionId: session.sessionId })
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' })
    expect(await read_turn(session)).toEqual({ updates: [], stop_reason: 'cancelled' })
    await session.prompt('second')
    expect(histories[1]).toEqual([{ role: 'user', text: 'first', cancelled: true }])
  })

  it('answers cancelled when something fails after the cancel', async () => {
    const flow = sequence([
      reply_step('partial'),
      step('stall', async (_: string, ctx) => {
        await until_aborted(ctx.abort)
        ctx.emit({ late: true })
        throw ctx.abort.reason
      }),
    ])
    const app = await acp_agent({
      name: 'test-agent',
      flow,
      to_updates: (event, state) => {
        if (event.kind === 'emit') throw new Error('could not map the late emit')
        return to_session_updates(event, state)
      },
    })
    const { agent, session } = await open_session(app)
    const response = session.prompt('go')
    await read_until(session, is_message)
    await agent.notify('session/cancel', { sessionId: session.sessionId })
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it("records the user's text and the reply already sent, marked cancelled, for a turn cancelled mid-reply", async () => {
    const { flow, histories } = history_probe({ reply_first: true })
    const app = await acp_agent({ name: 'test-agent', flow, to_input: (turn) => turn })
    const { agent, session } = await open_session(app)
    const response = session.prompt('first')
    await read_until(session, is_message)
    await agent.notify('session/cancel', { sessionId: session.sessionId })
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' })
    await session.prompt('second')
    expect(histories[1]).toEqual([
      { role: 'user', text: 'first' },
      { role: 'agent', text: 'partial', cancelled: true },
    ])
  })

  it('answers cancelled when the client cancels the request itself', async () => {
    const { flow, seen } = stalled_reply()
    const app = await acp_agent({ name: 'test-agent', flow })
    const { session } = await open_session(app)
    const cancel_request = new AbortController()
    const response = session.prompt('go', { cancellationSignal: cancel_request.signal })
    await read_until(session, is_message)
    cancel_request.abort()
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' })
    expect(seen.aborted).toBe(true)
  })

  it("answers cancelled when the config's abort fires", async () => {
    const { flow, seen } = stalled_reply()
    const shutdown = new AbortController()
    const app = await acp_agent({ name: 'test-agent', flow, abort: shutdown.signal })
    const { session } = await open_session(app)
    const response = session.prompt('go')
    await read_until(session, is_message)
    shutdown.abort()
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' })
    expect(seen.aborted).toBe(true)
  })

  it('cancels the turn in flight when a new prompt arrives, and the new turn sees it in its history', async () => {
    const { flow, histories, reasons } = history_probe({ reply_first: true })
    const app = await acp_agent({ name: 'test-agent', flow, to_input: (turn) => turn })
    const { agent, session } = await open_session(app)
    const first = session.prompt('first')
    await read_until(session, is_message)
    const second = session.prompt('second')
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })
    await expect(second).resolves.toEqual({ stopReason: 'end_turn' })
    expect(histories[1]).toEqual([
      { role: 'user', text: 'first' },
      { role: 'agent', text: 'partial', cancelled: true },
    ])
    expect(reasons).toEqual(['a new prompt replaced the turn'])
    // A cancel now targets the second turn, which has already finished.
    await agent.notify('session/cancel', { sessionId: session.sessionId })
  })

  it('leaves other sessions running when one is cancelled, and ignores a session with nothing to cancel', async () => {
    const errors = vi.spyOn(console, 'error')
    const { flow } = stalled_reply()
    const app = await acp_agent({ name: 'test-agent', flow })
    const { agent, session } = await open_session(app)
    const other = await agent.buildSession({ cwd: tmpdir(), mcpServers: [] }).start()
    const idle = await agent.buildSession({ cwd: tmpdir(), mcpServers: [] }).start()
    const first = session.prompt('go')
    const second = other.prompt('go')
    await read_until(session, is_message)
    await read_until(other, is_message)
    await agent.notify('session/cancel', { sessionId: 'nope' })
    await agent.notify('session/cancel', { sessionId: idle.sessionId })
    await agent.notify('session/cancel', { sessionId: other.sessionId })
    await expect(second).resolves.toEqual({ stopReason: 'cancelled' })
    await agent.notify('session/cancel', { sessionId: session.sessionId })
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' })
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('acp_agent: failures mid-turn', () => {
  it('aborts the run, with no unhandled rejection, when a send fails mid-turn', async () => {
    const unhandled: unknown[] = []
    const on_unhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', on_unhandled)
    try {
      const go_on = Promise.withResolvers<void>()
      const aborted = Promise.withResolvers<void>()
      const flow = sequence([
        reply_step('partial'),
        step('more', async (_: string, ctx) => {
          await go_on.promise
          stream_text(ctx, 'more')
          await until_aborted(ctx.abort)
          aborted.resolve()
          throw ctx.abort.reason
        }),
      ])
      const app = await acp_agent({ name: 'test-agent', flow })
      const { session, client_connection, agent_connection } = await open_session(app)
      const response = session.prompt('go')
      await read_until(session, is_message)
      client_connection.close()
      await expect(response).rejects.toThrow()
      go_on.resolve()
      await aborted.promise
      await agent_connection.closed
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', on_unhandled)
    }
  })

  it("fails the turn with to_updates' error and aborts the run", async () => {
    const aborted = Promise.withResolvers<unknown>()
    const flow = step('waits', async (_: string, ctx) => {
      ctx.emit({ boom: true })
      await until_aborted(ctx.abort)
      aborted.resolve(ctx.abort.reason)
      throw ctx.abort.reason
    })
    const app = await acp_agent({
      name: 'test-agent',
      flow,
      to_updates: (event) => {
        if (event.kind === 'emit') throw new Error('could not map the emit')
        return []
      },
    })
    const { session } = await open_session(app)
    await expect(session.prompt('go')).rejects.toThrow('Internal error: could not map the emit')
    await expect(aborted.promise).resolves.toMatchObject({
      name: 'aborted_error',
      message: 'the prompt turn failed before its run finished',
    })
  })
})

describe('acp_agent: run options', () => {
  it("records every run event on the config's trajectory logger", async () => {
    const recorded: TrajectoryEvent[] = []
    const trajectory: TrajectoryLogger = {
      record: (event) => {
        recorded.push(event)
      },
      start_span: (name) => name,
      end_span: () => {},
    }
    const app = await acp_agent({ name: 'test-agent', flow: reply_step('logged'), trajectory })
    const { session } = await open_session(app)
    await session.prompt('go')
    expect(recorded.map((event) => event.kind)).toContain('model_chunk')
  })

  it('runs turns without installing process signal handlers', async () => {
    const before = process.listenerCount('SIGTERM')
    const during: number[] = []
    const app = await acp_agent({
      name: 'test-agent',
      flow: step('count', () => {
        during.push(process.listenerCount('SIGTERM'))
        return 'ok'
      }),
    })
    const { session } = await open_session(app)
    await session.prompt('go')
    expect(during).toEqual([before])
  })

  it('requires to_input unless the flow takes a string', () => {
    const turn_flow = step('turn', (turn: AcpTurn) => turn.text)
    // @ts-expect-error: a flow over AcpTurn has no default input
    const missing: ServeAcpConfig<AcpTurn, string> = { name: 'test-agent', flow: turn_flow }
    const given: ServeAcpConfig<AcpTurn, string> = { name: 'test-agent', flow: turn_flow, to_input: (turn) => turn }
    const text: ServeAcpConfig<string, string> = { name: 'test-agent', flow: step('text', (t: string) => t) }
    expect([missing, given, text].map((config) => config.name)).toEqual(['test-agent', 'test-agent', 'test-agent'])
  })

  it('serves a client app that handles its own requests', async () => {
    const app = await acp_agent({ name: 'test-agent', flow: reply_step('hi') })
    const { session } = await open_session(app, { client: client({ name: 'test-client' }) })
    await session.prompt('go')
    expect(await read_turn(session)).toEqual({ updates: [message('hi')], stop_reason: 'end_turn' })
  })
})
