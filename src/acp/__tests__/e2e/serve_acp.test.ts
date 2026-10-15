import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { constants, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { ActiveSession } from '@agentclientprotocol/sdk'
import { read_turn } from '../../test/connect_client.js'

const here = dirname(fileURLToPath(import.meta.url))
const child_script = join(here, 'child-harness.ts')
const register_script = join(here, '..', '..', '..', '..', 'test', 'support', 'register-ts-resolver.mjs')

type ChildExit = {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

type SpawnedAgent = {
  readonly session: Promise<ActiveSession>
  /** Everything the child wrote to stdout, once it closes. */
  readonly stdout: Promise<string>
  readonly stderr: () => string
  readonly close_stdin: () => void
  readonly kill: (signal: NodeJS.Signals) => void
  readonly exit: Promise<ChildExit>
}

/**
 * Spawn the harness agent and connect a client to it over its stdio, the
 * way a host does, keeping a copy of every byte it writes to stdout.
 */
function spawn_agent(marker_dir: string): SpawnedAgent {
  const child = spawn(process.execPath, ['--import', register_script, child_script], {
    cwd: here,
    env: { ...process.env, MARKER_DIR: marker_dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exit = new Promise<ChildExit>((resolve) => {
    child.on('close', (code, signal) => {
      resolve({ code, signal })
    })
  })
  const [to_client, to_record] = Readable.toWeb(child.stdout).tee()
  const connection = client().connect(ndJsonStream(Writable.toWeb(child.stdin), to_client))
  const session = (async () => {
    await connection.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    return connection.agent.buildSession({ cwd: marker_dir, mcpServers: [] }).start()
  })()
  return {
    session,
    stdout: text(to_record),
    stderr: () => stderr,
    close_stdin: () => child.stdin.end(),
    kill: (signal) => child.kill(signal),
    exit,
  }
}

async function wait_for_marker(path: string, timeout_ms: number): Promise<void> {
  const deadline = Date.now() + timeout_ms
  for (;;) {
    try {
      await stat(path)
      return
    } catch {
      if (Date.now() >= deadline) throw new Error(`marker never appeared at ${path}`)
      await new Promise((resolve) => {
        setTimeout(resolve, 25)
      })
    }
  }
}

describe('serve_acp (spawned)', () => {
  let marker_dir = ''

  beforeEach(async () => {
    marker_dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-'))
  })

  afterEach(async () => {
    await rm(marker_dir, { recursive: true, force: true })
  })

  it('answers a prompt with only JSON-RPC on stdout, and disposes the engine when stdin closes', async () => {
    const agent = spawn_agent(marker_dir)
    const session = await agent.session
    await session.prompt('hello')
    expect(await read_turn(session)).toEqual({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo: hello' } }],
      stop_reason: 'end_turn',
    })

    agent.close_stdin()
    const result = await agent.exit
    expect(result, `stderr:\n${agent.stderr()}`).toEqual({ code: 0, signal: null })

    const lines = (await agent.stdout).split('\n').filter((line) => line.length > 0)
    expect(lines.length).toBeGreaterThanOrEqual(4)
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' })
    }
    expect(agent.stderr()).toContain('harness: console.log from the flow\n')
    expect(agent.stderr()).toContain('harness: engine disposed\n')
  }, 30_000)

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'aborts the turn in flight on %s, then exits with the signal code',
    async (signal) => {
      const agent = spawn_agent(marker_dir)
      const session = await agent.session
      void session.prompt('stall').catch(() => undefined)
      await wait_for_marker(join(marker_dir, 'ready'), 20_000)

      agent.kill(signal)
      const result = await agent.exit
      expect(result, `stderr:\n${agent.stderr()}`).toEqual({ code: 128 + constants.signals[signal], signal: null })
      expect(await readFile(join(marker_dir, 'aborted'), 'utf8')).toBe(`received ${signal}`)
    },
    30_000,
  )
})
