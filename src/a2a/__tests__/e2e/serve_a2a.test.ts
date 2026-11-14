import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { constants, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const child_script = join(here, 'child-harness.ts')
const register_script = join(here, '..', '..', '..', '..', 'test', 'support', 'register-ts-resolver.mjs')

type ChildExit = {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

type SpawnedAgent = {
  readonly stderr: () => string
  readonly kill: (signal: NodeJS.Signals) => void
  readonly exit: Promise<ChildExit>
}

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

function spawn_agent(marker_dir: string, port: number): SpawnedAgent {
  const child = spawn(process.execPath, ['--import', register_script, child_script], {
    cwd: here,
    env: { ...process.env, MARKER_DIR: marker_dir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
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
  return { stderr: () => stderr, kill: (signal) => child.kill(signal), exit }
}

async function wait_for_marker(path: string, timeout_ms: number): Promise<string> {
  const deadline = Date.now() + timeout_ms
  for (;;) {
    try {
      await stat(path)
      return await readFile(path, 'utf8')
    } catch {
      if (Date.now() >= deadline) throw new Error(`marker never appeared at ${path}`)
      await new Promise((resolve) => {
        setTimeout(resolve, 25)
      })
    }
  }
}

function send_message(url: string, text: string, return_immediately: boolean): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: {
        message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text }] },
        configuration: { returnImmediately: return_immediately },
      },
    }),
  })
}

describe('serve_a2a (spawned)', () => {
  let marker_dir = ''

  beforeEach(async () => {
    marker_dir = await mkdtemp(join(tmpdir(), 'fascicle-a2a-'))
  })

  afterEach(async () => {
    await rm(marker_dir, { recursive: true, force: true })
  })

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'serves on localhost, then on %s aborts the drive in flight, disposes the engine, and exits with the signal code',
    async (signal) => {
      const port = await free_port()
      const agent = spawn_agent(marker_dir, port)
      const url = await wait_for_marker(join(marker_dir, 'url'), 20_000)
      expect(url, `stderr:\n${agent.stderr()}`).toBe(`http://127.0.0.1:${port}`)

      const card = await fetch(`${url}/.well-known/agent-card.json`)
      expect(((await card.json()) as { name: string }).name).toBe('harness-agent')
      const echoed = (await (await send_message(url, 'hello', false)).json()) as {
        result: { task: { status: { state: string }; artifacts: Array<{ parts: Array<{ text: string }> }> } }
      }
      expect(echoed.result.task.status.state).toBe('TASK_STATE_COMPLETED')
      expect(echoed.result.task.artifacts[0]?.parts[0]?.text).toBe('echo: hello')

      const started = await send_message(url, 'stall', true)
      expect(started.status).toBe(200)
      await wait_for_marker(join(marker_dir, 'ready'), 20_000)

      agent.kill(signal)
      const result = await agent.exit
      expect(result, `stderr:\n${agent.stderr()}`).toEqual({ code: 128 + constants.signals[signal], signal: null })
      expect(await readFile(join(marker_dir, 'aborted'), 'utf8')).toBe('the agent closed while the task was running')
      expect(agent.stderr()).toContain('harness: engine disposed\n')
    },
    30_000,
  )
})
