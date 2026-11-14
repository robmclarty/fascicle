import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@agentclientprotocol/sdk'
import { step } from '#core'
import type { Tool } from '#engine'
import { acp_agent } from '../../acp_agent.js'
import { open_session, read_turn } from '../../test/connect_client.js'
import type { AcpSession, AcpTurn } from '../../types.js'

// Nothing here is mocked: `mcp_client` loads the real
// `@modelcontextprotocol/sdk` and starts the harness as a child process,
// the way a session starts a stdio server the editor sent.

const here = dirname(fileURLToPath(import.meta.url))
const harness_script = join(here, 'stdio-mcp-harness.ts')
const register_script = join(here, '..', '..', '..', '..', 'test', 'support', 'register-ts-resolver.mjs')

/** An argument a shell would expand, split, redirect, and run a command for. */
const SHELL_BAIT = '$HOME; echo ran > shell-ran && $(touch shell-ran) | * "q" \'s\' `id`'

/** What the harness's `started` tool reports about its own process. */
type Started = {
  readonly pid: number
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly mark: string | null
  readonly agent_only: boolean
}

/** Room for a node child to start and shake hands on a machine under load. */
const SPAWN_TIMEOUT_MS = 120_000

let cwd: string

beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'fascicle-acp-stdio-mcp-')))
  vi.stubEnv('HARNESS_AGENT_ONLY', 'the agent sees this and its MCP servers do not')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(cwd, { recursive: true, force: true })
})

/** The harness as the stdio server entry an editor sends with a session. */
function harness_entry(): McpServer {
  return {
    name: 'harness',
    command: process.execPath,
    args: ['--import', register_script, harness_script, SHELL_BAIT, '--flag'],
    env: [{ name: 'HARNESS_MARK', value: 'from the entry' }],
  }
}

/**
 * An agent whose flow calls the session's MCP tool the prompt names, with
 * the rest of the prompt as its `text`, and answers with what came back.
 */
async function calling_agent(): Promise<{ app: Awaited<ReturnType<typeof acp_agent>>; built: AcpSession[] }> {
  const built: AcpSession[] = []
  const app = await acp_agent({
    name: 'test-agent',
    version: '1.0.0',
    mcp_servers: true,
    flow: (session) => {
      built.push(session)
      return step('call', async (turn: AcpTurn, ctx) => {
        const [name = '', ...rest] = turn.text.split(' ')
        const tool: Tool | undefined = session.mcp_tools.find((entry) => entry.name === name)
        if (tool === undefined) throw new Error(`the session offers no tool named ${name}`)
        const output = await tool.execute({ text: rest.join(' ') }, { abort: ctx.abort, tool_call_id: 'call-1', step_index: 0 })
        return typeof output === 'string' ? output : JSON.stringify(output)
      })
    },
    to_input: (turn) => turn,
  })
  return { app, built }
}

/** The text of a turn's reply, joined. */
function reply_of(updates: Awaited<ReturnType<typeof read_turn>>['updates']): string {
  return updates
    .map((update) => (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? update.content.text : ''))
    .join('')
}

/** Whether a process with this pid is still there to be signalled. */
function is_running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Wait for a process to be gone. The MCP SDK's close gives the server two
 * seconds to exit before it signals it, and doesn't wait on the signal, so
 * on a loaded machine the process can outlast the close by a moment.
 */
async function gone(pid: number): Promise<void> {
  await vi.waitFor(() => expect(is_running(pid)).toBe(false), { timeout: SPAWN_TIMEOUT_MS / 2, interval: 50 })
}

/**
 * Open a session on the harness and ask it how it was started.
 */
async function started_session() {
  const { app, built } = await calling_agent()
  const opened = await open_session(app, { session: { cwd, mcpServers: [harness_entry()] } })
  await opened.session.prompt('mcp__harness__started')
  const turn = await read_turn(opened.session)
  expect(turn.stop_reason).toBe('end_turn')
  const started: Started = JSON.parse(reply_of(turn.updates))
  return { ...opened, built, started }
}

describe('a stdio MCP server a session starts', () => {
  it(
    'offers its tools under their session names, round-trips a call, starts with no shell, and is gone once the session closes',
    async () => {
      const { agent, session, built, started } = await started_session()

      expect(built[0]?.mcp_tools.map((entry) => entry.name)).toEqual(['mcp__harness__echo', 'mcp__harness__started'])

      await session.prompt('mcp__harness__echo over the wire and back')
      const echoed = await read_turn(session)
      expect(echoed.stop_reason).toBe('end_turn')
      expect(reply_of(echoed.updates)).toBe('echo: over the wire and back')

      // A shell would have expanded `$HOME`, split on `;`, and run `touch`.
      expect(started.args).toEqual([SHELL_BAIT, '--flag'])
      expect(await readdir(cwd)).toEqual([])
      expect(started.cwd).toBe(cwd)
      expect(started.mark).toBe('from the entry')
      expect(started.agent_only).toBe(false)
      expect(started.pid).not.toBe(process.pid)
      expect(is_running(started.pid)).toBe(true)

      await expect(agent.request('session/close', { sessionId: session.sessionId })).resolves.toEqual({})
      await gone(started.pid)
    },
    SPAWN_TIMEOUT_MS,
  )

  it(
    'is gone once the connection that held its session closes',
    async () => {
      const { agent_connection, started } = await started_session()
      expect(is_running(started.pid)).toBe(true)
      agent_connection.close()
      await agent_connection.closed
      await gone(started.pid)
    },
    SPAWN_TIMEOUT_MS,
  )
})
