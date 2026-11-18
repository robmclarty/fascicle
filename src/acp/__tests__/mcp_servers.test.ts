import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { client, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
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

/** A handle's `resources` for a server that publishes none. */
const NO_RESOURCES: McpClientHandle['resources'] = {
  list: async () => [],
  templates: async () => [],
  read: async () => [],
  subscribe: async () => {},
  unsubscribe: async () => {},
  on_list_changed: async () => {},
}

/** A connection whose `close` is a spy, offering `names`. */
function handle(...names: string[]): McpClientHandle & { readonly close: ReturnType<typeof vi.fn> } {
  return { tools: names.map(tool), close: vi.fn(async () => {}), resources: NO_RESOURCES }
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
    expect(NO_MCP).toEqual({ tools: [], close: expect.any(Function), warnings: [] })
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
      "fascicle/acp: MCP server files: it couldn't be reached (spawn ENOENT), so its tools are left out of the session\n",
      "fascicle/acp: MCP server old: it uses a transport this agent doesn't speak, so its tools are left out of the session\n",
    ])
    expect(connected.warnings).toEqual([
      {
        title: "MCP server files isn't connected",
        description: "it couldn't be reached (spawn ENOENT), so its tools are left out of the session",
      },
      {
        title: "MCP server old isn't connected",
        description: "it uses a transport this agent doesn't speak, so its tools are left out of the session",
      },
    ])
  })

  it('warns about a failure that is not an Error by what it is', async () => {
    vi.mocked(mcp_client).mockRejectedValueOnce('no route')
    await connect_mcp_servers([stdio], '/work', IDENTITY)
    expect(warnings()).toEqual([
      "fascicle/acp: MCP server files: it couldn't be reached (no route), so its tools are left out of the session\n",
    ])
  })

  it("cuts a server's env and headers values out of the warning its error would carry them in", async () => {
    const secret_stdio: McpServer = { ...stdio, env: [{ name: 'TOKEN', value: 'sk-secret-token' }, { name: 'DEBUG', value: '1' }] }
    const secret_http: McpServer = { ...http, headers: [{ name: 'Authorization', value: 'Bearer abcdef123456' }] }
    vi.mocked(mcp_client)
      .mockRejectedValueOnce(new Error('exit 1 with TOKEN=sk-secret-token'))
      .mockRejectedValueOnce(new Error('401 for Bearer abcdef123456'))
    const connected = await connect_mcp_servers([secret_stdio, secret_http], '/work', IDENTITY)
    expect(connected.warnings.map((warning) => warning.description)).toEqual([
      "it couldn't be reached (exit 1 with TOKEN=[redacted]), so its tools are left out of the session",
      "it couldn't be reached (401 for [redacted]), so its tools are left out of the session",
    ])
    const said = warnings().join('') + JSON.stringify(connected.warnings)
    expect(said).not.toContain('sk-secret-token')
    expect(said).not.toContain('abcdef123456')
  })

  it('cuts a short value out where it stands whole, and leaves the words and numbers it is only part of', async () => {
    const short_http: McpServer = {
      ...http,
      headers: [
        { name: 'X-Token', value: 'ab12cd' },
        { name: 'X-Retries', value: '1' },
        { name: 'X-Reach', value: 'reached' },
        { name: 'X-Mark', value: 'a.c' },
        { name: 'X-Empty', value: '' },
        { name: 'X-Long', value: 'ab12cd-and-more' },
      ],
    }
    const short_stdio: McpServer = { ...stdio, env: [{ name: 'PIN', value: '123456' }] }
    vi.mocked(mcp_client)
      .mockRejectedValueOnce(new Error('401 from 127.0.0.1:3100, token "ab12cd" refused (abc, a.c, ab12cd-and-more, xab12cd, ab12cd_)'))
      .mockRejectedValueOnce(new Error('spawn failed with PIN=123456 at 1234567'))
    const connected = await connect_mcp_servers([short_http, short_stdio], '/work', IDENTITY)
    expect(connected.warnings.map((warning) => warning.description)).toEqual([
      'it couldn\'t be reached (401 from 127.0.0.1:3100, token "[redacted]" refused (abc, [redacted], [redacted], xab12cd, ab12cd_)), so its tools are left out of the session',
      "it couldn't be reached (spawn failed with PIN=[redacted] at 1234567), so its tools are left out of the session",
    ])
    expect(warnings().join('')).not.toContain('"ab12cd"')
    expect(warnings().join('')).not.toContain('PIN=123456')
  })

  it('leaves a value of one or two characters where it is, and cuts one of three where it stands whole', async () => {
    const tiny: McpServer = {
      ...stdio,
      env: [
        { name: 'DEBUG', value: '1' },
        { name: 'COLOR', value: 'no' },
        { name: 'LEVEL', value: '0.' },
        { name: 'PORT', value: '127' },
        { name: 'MODE', value: 'dev' },
      ],
    }
    vi.mocked(mcp_client).mockRejectedValueOnce(new Error('exit 1 from 127.0.0.1, no route (0.), mode dev, devs 1270'))
    const connected = await connect_mcp_servers([tiny], '/work', IDENTITY)
    expect(connected.warnings.map((warning) => warning.description)).toEqual([
      "it couldn't be reached (exit 1 from [redacted].0.0.1, no route (0.), mode [redacted], devs 1270), so its tools are left out of the session",
    ])
    expect(warnings()).toEqual([
      "fascicle/acp: MCP server files: it couldn't be reached (exit 1 from [redacted].0.0.1, no route (0.), mode [redacted], devs 1270), so its tools are left out of the session\n",
    ])
  })

  it('cuts a value of eight characters wherever it appears, and one of seven only where it stands whole', async () => {
    const edge: McpServer = {
      ...stdio,
      env: [
        { name: 'EIGHT', value: 'abcd1234' },
        { name: 'SEVEN', value: 'wxyz789' },
      ],
    }
    vi.mocked(mcp_client).mockRejectedValueOnce(new Error('bad key xabcd1234y (abcd1234), bad pin xwxyz789y (wxyz789)'))
    const connected = await connect_mcp_servers([edge], '/work', IDENTITY)
    expect(connected.warnings.map((warning) => warning.description)).toEqual([
      "it couldn't be reached (bad key x[redacted]y ([redacted]), bad pin xwxyz789y ([redacted])), so its tools are left out of the session",
    ])
  })

  it('hands on a tool as its server gave it, and closes only the servers it reached when one was left out', async () => {
    const files = handle('mcp__files__read')
    const issues = handle('mcp__issues__open')
    vi.mocked(mcp_client)
      .mockResolvedValueOnce(files)
      .mockRejectedValueOnce(new Error('spawn ENOENT'))
      .mockResolvedValueOnce(issues)
    const connected = await connect_mcp_servers([stdio, { ...stdio, name: 'gone' }, http], '/work', IDENTITY)
    expect(connected.tools).toHaveLength(2)
    expect(connected.tools[0]).toBe(files.tools[0])
    expect(connected.tools[1]).toBe(issues.tools[0])
    stderr.mockClear()
    await expect(connected.close()).resolves.toBeUndefined()
    expect(files.close).toHaveBeenCalledOnce()
    expect(issues.close).toHaveBeenCalledOnce()
    expect(warnings()).toEqual([])
  })

  it('throws a missing MCP SDK on, and closes the servers it had reached', async () => {
    const files = handle('mcp__files__read')
    const missing = Object.assign(new Error('@modelcontextprotocol/sdk is required; install it: pnpm add @modelcontextprotocol/sdk'), {
      name: 'mcp_sdk_missing_error',
    })
    vi.mocked(mcp_client).mockResolvedValueOnce(files).mockRejectedValueOnce(missing)
    await expect(connect_mcp_servers([stdio, http], '/work', IDENTITY)).rejects.toBe(missing)
    expect(files.close).toHaveBeenCalledOnce()
    expect(warnings()).toEqual([])
  })

  it('says that a server which answered 401 wants a token in the editor settings, without the app-side advice', async () => {
    const refused = Object.assign(new Error('MCP server at https://mcp.example.com/mcp requires authorization (Unauthorized): pass `auth_provider` in the http config'), {
      name: 'mcp_auth_required_error',
    })
    vi.mocked(mcp_client).mockRejectedValueOnce(refused)
    const connected = await connect_mcp_servers([http], '/work', IDENTITY)
    expect(connected.tools).toEqual([])
    expect(connected.warnings).toEqual([
      {
        title: `MCP server ${http.name} isn't connected`,
        description:
          "it answered 401, which means that its entry in your editor's MCP settings sends no token it accepts (fix the entry's headers), so its tools are left out of the session",
      },
    ])
    expect(JSON.stringify(connected.warnings)).not.toContain('auth_provider')
  })

  it('gives the second of two tools that share a name one of its own, ending in a hash', async () => {
    const first = handle('mcp__my_server__x')
    const second = { tools: [{ ...tool('mcp__my_server__x'), description: 'second' }, tool('mcp__my_server__y')], close: vi.fn(async () => {}), resources: NO_RESOURCES }
    vi.mocked(mcp_client).mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const connected = await connect_mcp_servers([{ ...stdio, name: 'my server' }, { ...http, name: 'my.server' }], '/work', IDENTITY)
    const names = connected.tools.map((entry) => entry.name)
    expect(names).toHaveLength(3)
    expect(new Set(names).size).toBe(3)
    expect(names[0]).toBe('mcp__my_server__x')
    expect(names[1]).toMatch(/^mcp__my_server__x_[0-9a-f]{8}$/)
    expect(names[2]).toBe('mcp__my_server__y')
    expect(connected.tools[1]).toMatchObject({ description: 'second', execute: second.tools[0]?.execute })
    expect(warnings()).toEqual([])
  })

  it('gives two servers with one name and one tool a hash apiece, by their place in the list', async () => {
    vi.mocked(mcp_client).mockResolvedValueOnce(handle('mcp__a__x')).mockResolvedValueOnce(handle('mcp__a__x')).mockResolvedValueOnce(handle('mcp__a__x'))
    const twin = { ...stdio, name: 'a' }
    const connected = await connect_mcp_servers([twin, twin, twin], '/work', IDENTITY)
    expect(new Set(connected.tools.map((entry) => entry.name)).size).toBe(3)
  })

  it('cuts a name past 64 characters to 64, ending in a hash, and leaves one of exactly 64 alone', async () => {
    const long = `mcp__files__${'a'.repeat(60)}`
    const exact = `mcp__files__${'b'.repeat(52)}`
    vi.mocked(mcp_client).mockResolvedValueOnce(handle(long, exact))
    const connected = await connect_mcp_servers([stdio], '/work', IDENTITY)
    const [cut, kept] = connected.tools.map((entry) => entry.name)
    expect(cut).toHaveLength(64)
    expect(cut).toMatch(new RegExp(`^${long.slice(0, 55)}_[0-9a-f]{8}$`))
    expect(kept).toBe(exact)
  })

  it('leaves out a tool whose server lists it twice, with a warning', async () => {
    const long = `mcp__files__${'a'.repeat(60)}`
    vi.mocked(mcp_client).mockResolvedValueOnce(handle(long, long))
    const connected = await connect_mcp_servers([stdio], '/work', IDENTITY)
    expect(connected.tools).toHaveLength(1)
    expect(warnings()).toEqual([`fascicle/acp: MCP server files offers a tool named ${long} twice, so the second one is left out\n`])
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
    const gone = { code: -32002, message: 'Resource not found', data: { sessionId: session.sessionId } }
    await expect(session.prompt('still there?')).rejects.toMatchObject(gone)
    // The agent answers a second close with -32002 as well. The 2.x SDK's
    // client reads that as a session already closed and resolves, and the
    // 1.x client hands the error on.
    const again = await agent.request('session/close', { sessionId: session.sessionId }).then(
      () => 'closed',
      (err: unknown) => (err instanceof RequestError ? err.code : err),
    )
    expect(['closed', -32002]).toContain(again)
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

  it('fails session/new with the install line when the MCP SDK is missing', async () => {
    const missing = Object.assign(new Error('@modelcontextprotocol/sdk is required for fascicle/mcp; install it: pnpm add @modelcontextprotocol/sdk'), {
      name: 'mcp_sdk_missing_error',
    })
    vi.mocked(mcp_client).mockRejectedValueOnce(missing)
    const { app, built } = await mcp_agent()
    const { agent } = connect_client(app)
    await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await expect(agent.request('session/new', { cwd: tmpdir(), mcpServers: [stdio] })).rejects.toThrow(
      'Internal error: @modelcontextprotocol/sdk is required for fascicle/mcp; install it: pnpm add @modelcontextprotocol/sdk',
    )
    expect(built).toEqual([])
  })

  it('tells a client that shows notices which server was left out, at the first prompt, without its env values', async () => {
    const secret: McpServer = { ...stdio, env: [{ name: 'TOKEN', value: 'sk-secret-token' }] }
    vi.mocked(mcp_client).mockRejectedValueOnce(new Error('exit 1 with TOKEN=sk-secret-token'))
    const { app } = await mcp_agent()
    const { session } = await open_session(app, {
      client_capabilities: { session: { notices: {} } },
      session: { mcpServers: [secret] },
    })
    await session.prompt('first')
    const first = await read_turn(session)
    expect(first.updates[0]).toEqual({
      sessionUpdate: 'notice',
      severity: 'warning',
      title: "MCP server files isn't connected",
      description: "it couldn't be reached (exit 1 with TOKEN=[redacted]), so its tools are left out of the session",
    })
    await session.prompt('second')
    const second = await read_turn(session)
    expect(second.updates.filter((update) => update.sessionUpdate === 'notice')).toEqual([])
  })

  it.each([{}, { session: {} }, { session: { notices: null } }])(
    'sends no notice to a client whose capabilities are %j, which never asked for them',
    async (client_capabilities) => {
      vi.mocked(mcp_client).mockRejectedValueOnce(new Error('spawn ENOENT'))
      const { app } = await mcp_agent()
      const { session } = await open_session(app, { client_capabilities, session: { mcpServers: [stdio] } })
      await session.prompt('first')
      const turn = await read_turn(session)
      expect(turn.updates.filter((update) => update.sessionUpdate === 'notice')).toEqual([])
      expect(warnings()).toEqual([
        "fascicle/acp: MCP server files: it couldn't be reached (spawn ENOENT), so its tools are left out of the session\n",
      ])
    },
  )

  it('sends the notice for a loaded session before it answers, and keeps no server in the store', async () => {
    const root_dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-mcp-'))
    try {
      const store = filesystem_session_store({ root_dir })
      const make = () =>
        acp_agent({
          name: 'test-agent',
          mcp_servers: true,
          flow: () => step('noop', (_: AcpTurn) => 'ok'),
          to_input: (turn) => turn,
          session_store: store,
        })
      const secret: McpServer = { ...http, headers: [{ name: 'Authorization', value: 'Bearer abcdef123456' }] }
      vi.mocked(mcp_client).mockResolvedValueOnce(handle('mcp__issues__open'))
      const { session } = await open_session(await make(), { session: { mcpServers: [secret] } })
      await session.prompt('hello')
      await read_turn(session)
      const kept = JSON.stringify([await store.load(session.sessionId), await store.load_turns(session.sessionId, 1)])
      expect(kept).not.toContain('abcdef123456')
      expect(kept).not.toContain('mcp.example.com')

      vi.mocked(mcp_client).mockRejectedValueOnce(new Error('401'))
      const notices: unknown[] = []
      const client_app = client().onNotification('session/update', (ctx) => {
        if (ctx.params.update.sessionUpdate === 'notice') notices.push(ctx.params.update)
      })
      const { agent } = connect_client(await make(), client_app)
      await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { session: { notices: {} } } })
      await agent.request('session/load', { sessionId: session.sessionId, cwd: tmpdir(), mcpServers: [secret] })
      expect(notices).toEqual([
        {
          sessionUpdate: 'notice',
          severity: 'warning',
          title: "MCP server issues isn't connected",
          description: "it couldn't be reached (401), so its tools are left out of the session",
        },
      ])
    } finally {
      await rm(root_dir, { recursive: true, force: true })
    }
  })

  /**
   * A stored agent that connects to MCP servers, with one live session that
   * has had a turn, for a resume that arrives while the session is live.
   */
  async function live_session(servers: McpServer[], first: McpClientHandle) {
    const root_dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-mcp-'))
    const built: AcpSession[] = []
    let fail_build = false
    const app = await acp_agent({
      name: 'test-agent',
      version: '1.0.0',
      mcp_servers: true,
      flow: (session) => {
        if (fail_build) throw new Error('no flow for those servers')
        built.push(session)
        const names = session.mcp_tools.map((entry) => entry.name).join(', ')
        return step('tools', (_: AcpTurn) => names)
      },
      to_input: (turn) => turn,
      session_store: filesystem_session_store({ root_dir }),
    })
    vi.mocked(mcp_client).mockResolvedValueOnce(first)
    const opened = await open_session(app, { session: { mcpServers: servers } })
    await opened.session.prompt('which tools?')
    await read_turn(opened.session)
    const resume = (mcpServers: McpServer[]) =>
      opened.agent.request('session/resume', { sessionId: opened.session.sessionId, cwd: tmpdir(), mcpServers })
    const tools_now = async (): Promise<string> => {
      await opened.session.prompt('which tools?')
      const turn = await read_turn(opened.session)
      const said = turn.updates.find((update) => update.sessionUpdate === 'agent_message_chunk')
      return said?.sessionUpdate === 'agent_message_chunk' && said.content.type === 'text' ? said.content.text : ''
    }
    return {
      ...opened,
      built,
      resume,
      tools_now,
      fail_builds: () => {
        fail_build = true
      },
      cleanup: () => rm(root_dir, { recursive: true, force: true }),
    }
  }

  it('switches a live session to the servers a resume brings: it closes the old ones and builds the flow on the new', async () => {
    const files = handle('mcp__files__read')
    const issues = handle('mcp__issues__open')
    const live = await live_session([stdio], files)
    try {
      vi.mocked(mcp_client).mockResolvedValueOnce(issues)
      await live.resume([http])
      await vi.waitFor(() => {
        expect(files.close).toHaveBeenCalledOnce()
      })
      expect(issues.close).not.toHaveBeenCalled()
      expect(live.built).toHaveLength(2)
      expect(await live.tools_now()).toBe('mcp__issues__open')
      const needs = live.built[1]?.mcp_tools[0]?.needs_approval
      expect(typeof needs === 'function' && (await needs({}))).toBe(true)
      await live.agent.request('session/close', { sessionId: live.session.sessionId })
      expect(issues.close).toHaveBeenCalledOnce()
      expect(files.close).toHaveBeenCalledOnce()
    } finally {
      await live.cleanup()
    }
  })

  it('changes nothing for a resume that brings the same servers, or names none', async () => {
    const files = handle('mcp__files__read')
    const live = await live_session([stdio], files)
    try {
      await live.resume([stdio])
      await live.agent.request('session/resume', { sessionId: live.session.sessionId, cwd: tmpdir() })
      expect(mcp_client).toHaveBeenCalledOnce()
      expect(files.close).not.toHaveBeenCalled()
      expect(live.built).toHaveLength(1)
      expect(await live.tools_now()).toBe('mcp__files__read')
    } finally {
      await live.cleanup()
    }
  })

  it('drops a live session to no servers when a resume brings an empty list', async () => {
    const files = handle('mcp__files__read')
    const live = await live_session([stdio], files)
    try {
      await live.resume([])
      await vi.waitFor(() => {
        expect(files.close).toHaveBeenCalledOnce()
      })
      expect(await live.tools_now()).toBe('')
    } finally {
      await live.cleanup()
    }
  })

  it('switches a live session that has had no turn, and tells the client which of the new servers was left out', async () => {
    const root_dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-mcp-'))
    try {
      const files = handle('mcp__files__read')
      const app = await acp_agent({
        name: 'test-agent',
        mcp_servers: true,
        flow: () => step('noop', (_: AcpTurn) => 'ok'),
        to_input: (turn) => turn,
        session_store: filesystem_session_store({ root_dir }),
      })
      const notices: unknown[] = []
      const client_app = client().onNotification('session/update', (ctx) => {
        if (ctx.params.update.sessionUpdate === 'notice') notices.push(ctx.params.update)
      })
      vi.mocked(mcp_client).mockResolvedValueOnce(files).mockRejectedValueOnce(new Error('401'))
      const { agent, session } = await open_session(app, {
        client: client_app,
        client_capabilities: { session: { notices: {} } },
        session: { mcpServers: [stdio] },
      })
      await agent.request('session/resume', { sessionId: session.sessionId, cwd: tmpdir(), mcpServers: [http] })
      expect(notices).toEqual([
        {
          sessionUpdate: 'notice',
          severity: 'warning',
          title: "MCP server issues isn't connected",
          description: "it couldn't be reached (401), so its tools are left out of the session",
        },
      ])
      await vi.waitFor(() => {
        expect(files.close).toHaveBeenCalledOnce()
      })
    } finally {
      await rm(root_dir, { recursive: true, force: true })
    }
  })

  it('builds no flow again for a resume that brings other servers to an agent that connects to none', async () => {
    const root_dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-mcp-'))
    try {
      let built = 0
      const app = await acp_agent({
        name: 'test-agent',
        flow: () => {
          built += 1
          return step('noop', (_: AcpTurn) => 'ok')
        },
        to_input: (turn) => turn,
        session_store: filesystem_session_store({ root_dir }),
      })
      const { agent, session } = await open_session(app, { session: { mcpServers: [stdio] } })
      await agent.request('session/resume', { sessionId: session.sessionId, cwd: tmpdir(), mcpServers: [http] })
      expect(built).toBe(1)
      expect(mcp_client).not.toHaveBeenCalled()
    } finally {
      await rm(root_dir, { recursive: true, force: true })
    }
  })

  it('leaves a live session on the servers it had when the flow builder throws for the new ones', async () => {
    const files = handle('mcp__files__read')
    const issues = handle('mcp__issues__open')
    const live = await live_session([stdio], files)
    try {
      vi.mocked(mcp_client).mockResolvedValueOnce(issues)
      live.fail_builds()
      await expect(live.resume([http])).rejects.toThrow('Internal error: no flow for those servers')
      expect(issues.close).toHaveBeenCalledOnce()
      expect(files.close).not.toHaveBeenCalled()
      expect(live.built[0]?.mcp_tools.map((entry) => entry.name)).toEqual(['mcp__files__read'])
      expect(await live.tools_now()).toBe('mcp__files__read')
    } finally {
      await live.cleanup()
    }
  })

  it('waits for the turn in flight before it closes the servers a resume replaced', async () => {
    const root_dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-mcp-'))
    try {
      const files = handle('mcp__files__read')
      const release = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      const app = await acp_agent({
        name: 'test-agent',
        mcp_servers: true,
        flow: () =>
          step('slow', async (_: AcpTurn) => {
            started.resolve()
            await release.promise
            return 'ok'
          }),
        to_input: (turn) => turn,
        session_store: filesystem_session_store({ root_dir }),
      })
      vi.mocked(mcp_client).mockResolvedValueOnce(files).mockResolvedValueOnce(handle('mcp__issues__open'))
      const { agent, session } = await open_session(app, { session: { mcpServers: [stdio] } })
      const turn = session.prompt('go')
      await started.promise
      await agent.request('session/resume', { sessionId: session.sessionId, cwd: tmpdir(), mcpServers: [http] })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(files.close).not.toHaveBeenCalled()
      release.resolve()
      await turn
      await vi.waitFor(() => {
        expect(files.close).toHaveBeenCalledOnce()
      })
    } finally {
      await rm(root_dir, { recursive: true, force: true })
    }
  })

  it("closes a session's servers when the session is deleted", async () => {
    const root_dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-mcp-'))
    try {
      const files = handle('mcp__files__read')
      vi.mocked(mcp_client).mockResolvedValueOnce(files)
      const app = await acp_agent({
        name: 'test-agent',
        mcp_servers: true,
        flow: () => step('noop', (_: AcpTurn) => 'ok'),
        to_input: (turn) => turn,
        session_store: filesystem_session_store({ root_dir }),
      })
      const { agent, session } = await open_session(app, { session: { mcpServers: [stdio] } })
      await agent.request('session/delete', { sessionId: session.sessionId })
      expect(files.close).toHaveBeenCalledOnce()
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
