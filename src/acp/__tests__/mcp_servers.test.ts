import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { McpServer } from '@agentclientprotocol/sdk'
import { step } from '#core'
import type { Tool } from '#engine'
import { mcp_client } from '#mcp'
import type { McpClientHandle } from '#mcp'
import { json_schema_to_standard } from '#schema'
import { acp_agent } from '../acp_agent.js'
import { connect_mcp_servers, gated_mcp_tools, is_mcp_call, NO_MCP } from '../mcp_servers.js'
import { filesystem_session_store } from '../session_store.js'
import { connect_client, open_session, read_turn } from '../test/connect_client.js'
import type { AcpMode, AcpSession, AcpTurn } from '../types.js'

// No server is spawned and no socket opened: each test says what connecting
// to a server gives back.
vi.mock('#mcp', () => ({ mcp_client: vi.fn() }))

const IDENTITY = { name: 'test-agent', version: '1.0.0' }

/** A tool as `mcp_client` surfaces one, already carrying its prefix. */
function tool(name: string): Tool {
  return { name, description: name, input_schema: json_schema_to_standard({ type: 'object' }), execute: () => `${name} ran` }
}

/** A connection whose `close` is a spy, offering `names`. */
function handle(...names: string[]): McpClientHandle & { readonly close: ReturnType<typeof vi.fn> } {
  return { tools: names.map(tool), close: vi.fn(async () => {}) }
}

const stdio: McpServer = { name: 'files', command: '/bin/files-mcp', args: ['--root', '.'], env: [{ name: 'TOKEN', value: 't' }] }
const http: McpServer = {
  type: 'http',
  name: 'issues',
  url: 'https://mcp.example.com/mcp',
  headers: [{ name: 'Authorization', value: 'Bearer x' }],
}

let stderr: MockInstance<typeof process.stderr.write>

beforeEach(() => {
  stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(mcp_client).mockReset()
})

/** Every warning written to stderr, in order. */
function warnings(): string[] {
  return stderr.mock.calls.map(([text]) => String(text))
}

describe('connect_mcp_servers', () => {
  it('connects to nothing for a session the client sent no servers with', async () => {
    expect(await connect_mcp_servers([], '/work', IDENTITY)).toBe(NO_MCP)
    expect(mcp_client).not.toHaveBeenCalled()
    await expect(NO_MCP.close()).resolves.toBeUndefined()
  })

  it('starts a stdio server in the cwd with its args and env, and reaches an HTTP one with its headers', async () => {
    vi.mocked(mcp_client).mockResolvedValueOnce(handle('mcp__files__read')).mockResolvedValueOnce(handle('mcp__issues__open'))
    const connected = await connect_mcp_servers([stdio, http], '/work', IDENTITY)
    expect(vi.mocked(mcp_client).mock.calls).toEqual([
      [
        { transport: 'stdio', command: '/bin/files-mcp', args: ['--root', '.'], env: { TOKEN: 't' }, cwd: '/work' },
        { client_info: IDENTITY, name_prefix: 'mcp__files__' },
      ],
      [
        { transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer x' } },
        { client_info: IDENTITY, name_prefix: 'mcp__issues__' },
      ],
    ])
    expect(connected.tools.map((entry) => entry.name)).toEqual(['mcp__files__read', 'mcp__issues__open'])
    expect(warnings()).toEqual([])
  })

  it("names a server's tools with only the characters a tool name can carry", async () => {
    vi.mocked(mcp_client).mockResolvedValueOnce(handle())
    await connect_mcp_servers([{ ...stdio, name: 'my.server (dev)' }], '/work', IDENTITY)
    expect(vi.mocked(mcp_client).mock.calls[0]?.[1]).toMatchObject({ name_prefix: 'mcp__my_server__dev___' })
  })

  it('leaves out a server it fails to reach and one whose transport it does not speak, with a warning for each', async () => {
    const sse: McpServer = { type: 'sse', name: 'old', url: 'https://old.example.com/sse', headers: [] }
    vi.mocked(mcp_client).mockRejectedValueOnce(new Error('spawn ENOENT')).mockResolvedValueOnce(handle('mcp__issues__open'))
    const connected = await connect_mcp_servers([stdio, sse, http], '/work', IDENTITY)
    expect(connected.tools.map((entry) => entry.name)).toEqual(['mcp__issues__open'])
    expect(warnings().toSorted()).toEqual([
      "fascicle/acp: MCP server old uses a transport this agent doesn't speak, so its tools are left out of the session\n",
      "fascicle/acp: couldn't connect to MCP server files (spawn ENOENT), so its tools are left out of the session\n",
    ])
  })

  it('warns about a failure that is not an Error by what it is', async () => {
    vi.mocked(mcp_client).mockRejectedValueOnce('no route')
    await connect_mcp_servers([stdio], '/work', IDENTITY)
    expect(warnings()).toEqual([
      "fascicle/acp: couldn't connect to MCP server files (no route), so its tools are left out of the session\n",
    ])
  })

  it('keeps the first tool to take a name two servers share', async () => {
    const first = handle('mcp__a__x')
    const second = { tools: [{ ...tool('mcp__a__x'), description: 'second' }, tool('mcp__a__y')], close: vi.fn(async () => {}) }
    vi.mocked(mcp_client).mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const connected = await connect_mcp_servers([{ ...stdio, name: 'a' }, { ...http, name: 'a' }], '/work', IDENTITY)
    expect(connected.tools.map((entry) => [entry.name, entry.description])).toEqual([
      ['mcp__a__x', 'mcp__a__x'],
      ['mcp__a__y', 'mcp__a__y'],
    ])
    expect(warnings()).toEqual([
      "fascicle/acp: two MCP servers offer a tool named mcp__a__x, so the second one's is left out\n",
    ])
  })

  it('closes every server it reached, warning about each one that fails to close', async () => {
    const files = handle('mcp__files__read')
    const issues = handle('mcp__issues__open')
    const quiet = handle('mcp__quiet__ping')
    files.close.mockRejectedValueOnce(new Error('broken pipe'))
    issues.close.mockRejectedValueOnce('gone')
    vi.mocked(mcp_client).mockResolvedValueOnce(files).mockResolvedValueOnce(issues).mockResolvedValueOnce(quiet)
    const connected = await connect_mcp_servers([stdio, http, { ...stdio, name: 'quiet' }], '/work', IDENTITY)
    await connected.close()
    expect(files.close).toHaveBeenCalledOnce()
    expect(issues.close).toHaveBeenCalledOnce()
    expect(quiet.close).toHaveBeenCalledOnce()
    expect(warnings()).toEqual([
      "fascicle/acp: couldn't close an MCP server (broken pipe)\n",
      "fascicle/acp: couldn't close an MCP server (gone)\n",
    ])
  })
})

/** A session whose mode is whatever `mode` says at each call. */
function session_in(mode: () => AcpMode): AcpSession {
  return {
    id: 's',
    cwd: '/work',
    additional_directories: [],
    roots: ['/work'],
    client_capabilities: {},
    mode,
    model: () => undefined,
    mcp_tools: [],
    approve: () => false,
  }
}

describe('gated_mcp_tools', () => {
  it('asks before a call whenever the mode asks before a command, and reads the mode at each call', async () => {
    let mode: AcpMode = 'manual'
    const session = session_in(() => mode)
    const [gated] = gated_mcp_tools([tool('mcp__a__x')], () => session)
    const needs = gated?.needs_approval
    if (typeof needs !== 'function') throw new Error('the tool never asks')
    expect(await needs({})).toBe(true)
    mode = 'accept_edits'
    expect(await needs({})).toBe(true)
    mode = 'auto'
    expect(await needs({})).toBe(false)
  })

  it('keeps the tool as it was apart from the asking', () => {
    const raw = tool('mcp__a__x')
    const [gated] = gated_mcp_tools([raw], () => session_in(() => 'auto'))
    expect(gated).toMatchObject({ name: raw.name, description: raw.description, execute: raw.execute })
  })

  it("knows a call by the input its tool was asked about, in that session alone", async () => {
    const session = session_in(() => 'manual')
    const other = session_in(() => 'manual')
    const [gated] = gated_mcp_tools([tool('mcp__a__x')], () => session)
    const input = { q: 1 }
    expect(is_mcp_call(session, input)).toBe(false)
    if (typeof gated?.needs_approval !== 'function') throw new Error('the tool never asks')
    await gated.needs_approval(input)
    expect(is_mcp_call(session, input)).toBe(true)
    expect(is_mcp_call(session, { q: 1 })).toBe(false)
    expect(is_mcp_call(other, input)).toBe(false)
    await gated.needs_approval('not an object')
    expect(is_mcp_call(session, 'not an object')).toBe(false)
  })
})

/**
 * An agent that connects to the client's MCP servers and records each
 * session its flow is built for. Its flow answers with the names of the
 * session's MCP tools.
 */
async function mcp_agent(overrides: { mcp_servers?: boolean; flow_throws?: boolean } = {}) {
  const built: AcpSession[] = []
  const app = await acp_agent({
    name: 'test-agent',
    version: '1.0.0',
    mcp_servers: overrides.mcp_servers ?? true,
    flow: (session) => {
      built.push(session)
      if (overrides.flow_throws === true) throw new Error('no flow for you')
      return step('tools', (_: AcpTurn) => session.mcp_tools.map((entry) => entry.name).join(', '))
    },
    to_input: (turn) => turn,
  })
  return { app, built }
}

describe('acp_agent: MCP servers', () => {
  it('tells the client it reaches MCP servers over HTTP as well as stdio', async () => {
    const { app } = await mcp_agent()
    const { agent } = connect_client(app)
    const response = await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(response.agentCapabilities?.mcpCapabilities).toEqual({ http: true })
  })

  it("hands the flow builder the tools of the session's servers, connected in its cwd as the agent", async () => {
    vi.mocked(mcp_client).mockResolvedValueOnce(handle('mcp__files__read', 'mcp__files__write'))
    const { app, built } = await mcp_agent()
    const { session } = await open_session(app, { session: { mcpServers: [stdio] } })
    expect(vi.mocked(mcp_client).mock.calls[0]).toEqual([
      expect.objectContaining({ transport: 'stdio', cwd: tmpdir() }),
      { client_info: IDENTITY, name_prefix: 'mcp__files__' },
    ])
    expect(built[0]?.mcp_tools.map((entry) => entry.name)).toEqual(['mcp__files__read', 'mcp__files__write'])
    await session.prompt('which tools?')
    const turn = await read_turn(session)
    expect(turn.updates).toContainEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'mcp__files__read, mcp__files__write' },
    })
  })

  it('gates each MCP tool on the session it was built for', async () => {
    vi.mocked(mcp_client).mockResolvedValueOnce(handle('mcp__files__read'))
    const { app, built } = await mcp_agent()
    await open_session(app, { session: { mcpServers: [stdio] } })
    const [session] = built
    const needs = session?.mcp_tools[0]?.needs_approval
    if (session === undefined || typeof needs !== 'function') throw new Error('the tool never asks')
    const input = { path: 'a' }
    expect(await needs(input)).toBe(true)
    expect(is_mcp_call(session, input)).toBe(true)
  })

  it('ignores the servers the client sends unless the config asks for them', async () => {
    const { app, built } = await mcp_agent({ mcp_servers: false })
    const { agent } = connect_client(app)
    const response = await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    expect(response.agentCapabilities).not.toHaveProperty('mcpCapabilities')
    await agent.request('session/new', { cwd: tmpdir(), mcpServers: [stdio] })
    expect(mcp_client).not.toHaveBeenCalled()
    expect(built[0]?.mcp_tools).toEqual([])
  })

  it('closes the servers again when the flow builder throws', async () => {
    const files = handle('mcp__files__read')
    vi.mocked(mcp_client).mockResolvedValueOnce(files)
    const { app } = await mcp_agent({ flow_throws: true })
    const { agent } = connect_client(app)
    await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(agent.request('session/new', { cwd: tmpdir(), mcpServers: [stdio] })).rejects.toThrow('no flow for you')
    expect(files.close).toHaveBeenCalledOnce()
  })

  it('closes a session and its servers on session/close, after which the session is gone', async () => {
    const files = handle('mcp__files__read')
    vi.mocked(mcp_client).mockResolvedValueOnce(files)
    const { app } = await mcp_agent()
    const { agent, session } = await open_session(app, { session: { mcpServers: [stdio] } })
    await expect(agent.request('session/close', { sessionId: session.sessionId })).resolves.toEqual({})
    expect(files.close).toHaveBeenCalledOnce()
    await expect(session.prompt('still there?')).rejects.toThrow(`unknown session ${session.sessionId}`)
    await expect(agent.request('session/close', { sessionId: session.sessionId })).rejects.toThrow(
      `unknown session ${session.sessionId}`,
    )
  })

  it('connects a stored session to the servers its load sends', async () => {
    const root_dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-mcp-'))
    try {
      const make = () =>
        acp_agent({
          name: 'test-agent',
          version: '1.0.0',
          mcp_servers: true,
          flow: () => step('noop', (_: AcpTurn) => 'ok'),
          to_input: (turn) => turn,
          session_store: filesystem_session_store({ root_dir }),
        })
      vi.mocked(mcp_client).mockResolvedValue(handle('mcp__files__read'))
      const { session } = await open_session(await make(), { session: { mcpServers: [stdio] } })
      await session.prompt('hello')
      await read_turn(session)
      const { agent } = connect_client(await make())
      await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      await agent.request('session/load', { sessionId: session.sessionId, cwd: tmpdir(), mcpServers: [http] })
      await agent.request('session/resume', { sessionId: session.sessionId, cwd: tmpdir() })
      expect(vi.mocked(mcp_client).mock.calls.map(([config]) => config.transport)).toEqual(['stdio', 'http'])
    } finally {
      await rm(root_dir, { recursive: true, force: true })
    }
  })

  it('connects a resumed session to no servers when its resume sends none', async () => {
    const root_dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-mcp-'))
    try {
      const make = () =>
        acp_agent({
          name: 'test-agent',
          mcp_servers: true,
          flow: () => step('noop', (_: AcpTurn) => 'ok'),
          to_input: (turn) => turn,
          session_store: filesystem_session_store({ root_dir }),
        })
      const { session } = await open_session(await make())
      await session.prompt('hello')
      await read_turn(session)
      const { agent } = connect_client(await make())
      await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      await agent.request('session/resume', { sessionId: session.sessionId, cwd: tmpdir() })
      expect(mcp_client).not.toHaveBeenCalled()
    } finally {
      await rm(root_dir, { recursive: true, force: true })
    }
  })

  it("closes every session's servers once the connection closes", async () => {
    const files = handle('mcp__files__read')
    const issues = handle('mcp__issues__open')
    vi.mocked(mcp_client).mockResolvedValueOnce(files).mockResolvedValueOnce(issues)
    const { app } = await mcp_agent()
    const { agent, agent_connection } = await open_session(app, { session: { mcpServers: [stdio] } })
    await agent.buildSession({ cwd: tmpdir(), mcpServers: [http] }).start()
    agent_connection.close()
    await agent_connection.closed
    await vi.waitFor(() => {
      expect(files.close).toHaveBeenCalledOnce()
      expect(issues.close).toHaveBeenCalledOnce()
    })
  })
})
