import { getEventListeners } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Tool } from '#engine'
import { to_json_schema } from '#schema'
import { resolve_roots } from '../tools/containment.js'
import type { AcpSession, WorkspaceToolsOptions } from '../types.js'
import { workspace_tools } from '../workspace_tools.js'

/**
 * The fixture, under one scratch directory:
 *
 *   project/        the workspace, where every command starts
 *     notes.md      a file for read_file, which still works on Windows
 *     escape.cjs    starts `sleep 30` in a session of its own, holding the
 *                   command's output open, and prints its pid
 *
 * The tests that need to see a background job write its pid to a file
 * through a rename, so the file appears whole, and wait for that file
 * rather than for a length of time.
 */
let base: string
let cwd: string
let session: AcpSession

/** What `run_command` says when the output it returns was cut. */
const PIPE_HINT = 'pipe the command through tail, head, or grep to see the part you need'

/** The note that ends a report when something outside the group held the output open. */
const HELD_NOTE =
  '[the command exited, but something it moved out of its process group held its output open, so run_command stopped reading and left that running]'

/** A session over `root`, its roots resolved the way `session/new` does. */
async function session_over(root: string): Promise<AcpSession> {
  return {
    id: 'session-1',
    cwd: root,
    additional_directories: [],
    roots: await resolve_roots([root]),
    client_capabilities: {},
  }
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'fascicle-acp-run-command-')))
  cwd = join(base, 'project')
  await mkdir(cwd)
  await writeFile(join(cwd, 'notes.md'), 'one\n')
  await writeFile(
    join(cwd, 'escape.cjs'),
    [
      "const { spawn } = require('node:child_process')",
      "const child = spawn('sleep', ['30'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })",
      'child.unref()',
      'console.log(child.pid)',
    ].join('\n'),
  )
  session = await session_over(cwd)
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

/** Find one tool by name in a session's workspace tools. */
function tool_named(name: string, over: AcpSession = session, options?: WorkspaceToolsOptions): Tool {
  const found = workspace_tools(over, options).find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`workspace_tools has no ${name}`)
  return found
}

/** Call `run_command` the way the tool loop does. */
async function run(
  input: unknown,
  options: { over?: AcpSession; tools?: WorkspaceToolsOptions; abort?: AbortSignal } = {},
): Promise<unknown> {
  const tool = tool_named('run_command', options.over ?? session, options.tools)
  return tool.execute(input, {
    abort: options.abort ?? new AbortController().signal,
    tool_call_id: 'call-1',
    step_index: 0,
  })
}

/** What a call settles with: its result, or the error it rejected with. */
async function settled(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    (result) => result,
    (err: unknown) => err,
  )
}

/** Whether a process is running: signal 0 checks without sending anything. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Wait until `check` holds, failing with `what` if it doesn't within five seconds. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`)
    await sleep(10)
  }
}

/**
 * A command that starts `sleep 30` in the background, writes its pid to
 * `name` under cwd, and waits for it, after running `before`.
 */
function background_job(name: string, before = ''): { command: string; pid_file: string } {
  const pid_file = join(cwd, name)
  return { command: `${before}sleep 30 & echo $! > ${pid_file}.tmp; mv ${pid_file}.tmp ${pid_file}; wait`, pid_file }
}

/** Wait for a background job's pid file to appear, then read the pid. */
async function job_pid(pid_file: string): Promise<number> {
  await until(() => existsSync(pid_file), 'the background job to start')
  return Number(await readFile(pid_file, 'utf8'))
}

describe('run_command', () => {
  it('describes itself to the model with its timeout and cap, and declares its input as JSON Schema', () => {
    const tool = tool_named('run_command', session, { command_timeout_ms: 5000, output_limit_bytes: 1000 })
    expect(tool.description).toBe(
      'Run a shell command with /bin/sh -c in the workspace root, and return what it printed (stdout and stderr together) and its exit code. ' +
        'Each call starts a fresh shell there, so a cd lasts for its own command only. ' +
        'The command is stopped after 5 s unless timeout_ms says otherwise, ' +
        'and output past 1000 bytes is cut, so pipe a long one through tail, head, or grep. ' +
        "It gets no input, and anything it starts is stopped once it exits, so it can't leave a server or a watcher running.",
    )
    expect(to_json_schema(tool.input_schema)).toEqual({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line, as you would type it in a POSIX shell' },
        timeout_ms: {
          type: 'integer',
          minimum: 1,
          description: 'How long the command may run, in milliseconds; default: 5000',
        },
      },
      required: ['command'],
      additionalProperties: false,
    })
  })

  it('defaults to a 120 s timeout and a 32,000 byte cap', () => {
    const tool = tool_named('run_command')
    expect(tool.description).toContain('stopped after 120 s unless')
    expect(tool.description).toContain('output past 32000 bytes is cut')
    expect(to_json_schema(tool.input_schema)).toMatchObject({
      properties: { timeout_ms: { description: 'How long the command may run, in milliseconds; default: 120000' } },
    })
  })

  it('runs the command through /bin/sh in cwd, returns its output and exit code, and leaves no listener behind', async () => {
    const controller = new AbortController()
    await expect(run({ command: 'pwd; echo "$0"' }, { abort: controller.signal })).resolves.toBe(
      `${cwd}\n/bin/sh\n[exit code 0]`,
    )
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('reports a non-zero exit as a result, with stdout and stderr together', async () => {
    const result = String(await run({ command: 'echo out; echo err >&2; exit 3' }))
    const lines = result.split('\n')
    // The two streams are separate pipes, so either may arrive first.
    expect(lines.slice(0, 2).toSorted()).toEqual(['err', 'out'])
    expect(lines.slice(2)).toEqual(['[exit code 3]'])
  })

  it('reports the signal that ended a command', async () => {
    await expect(run({ command: 'kill -TERM $$' })).resolves.toBe('[no output]\n[ended by SIGTERM]')
  })

  it('says when a command printed nothing, and drops trailing whitespace', async () => {
    await expect(run({ command: 'true' })).resolves.toBe('[no output]\n[exit code 0]')
    await expect(run({ command: 'echo' })).resolves.toBe('[exit code 0]')
    await expect(run({ command: "printf 'a  \\n\\n'" })).resolves.toBe('a\n[exit code 0]')
  })

  it('gives the command no input, so one that reads it finishes', async () => {
    await expect(run({ command: 'cat' })).resolves.toBe('[no output]\n[exit code 0]')
  })

  it('cuts the output at output_limit_bytes and reads on until the command ends', async () => {
    // A megabyte is far more than a pipe holds, so the command finishes only
    // if its output goes on being read past the cap.
    const command = "head -c 1000000 /dev/zero | tr '\\0' a; echo; echo done >&2"
    await expect(run({ command }, { tools: { output_limit_bytes: 100 } })).resolves.toBe(
      `${'a'.repeat(100)}\n[output cut at 100 bytes of 1000006; ${PIPE_HINT}]\n[exit code 0]`,
    )
  })

  it('cuts at a character boundary, and keeps output that fits the cap exactly', async () => {
    await expect(run({ command: "printf 'ééé'" }, { tools: { output_limit_bytes: 5 } })).resolves.toBe(
      `éé\n[output cut at 5 bytes of 6; ${PIPE_HINT}]\n[exit code 0]`,
    )
    await expect(run({ command: "printf 'ééé'" }, { tools: { output_limit_bytes: 6 } })).resolves.toBe(
      'ééé\n[exit code 0]',
    )
  })

  it('keeps a character whole when its bytes arrive in two writes', async () => {
    await expect(run({ command: "printf '\\303'; sleep 0.1; printf '\\251'" })).resolves.toBe('é\n[exit code 0]')
  })

  it('shows only the marker when the cap keeps nothing', async () => {
    await expect(run({ command: 'echo hi' }, { tools: { output_limit_bytes: 0 } })).resolves.toBe(
      `[output cut at 0 bytes of 3; ${PIPE_HINT}]\n[exit code 0]`,
    )
  })

  it("kills the whole group at the call's timeout_ms, and reports what the command printed before then", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const job = background_job('timeout.pid', 'echo started; echo waiting; ')
    const call = settled(run({ command: job.command, timeout_ms: 1500 }, { tools: { output_limit_bytes: 10 } }))
    const pid = await job_pid(job.pid_file)
    vi.advanceTimersByTime(1499)
    // Nothing settles a beat short of the timeout: the job sleeps for 30 s.
    await sleep(50)
    expect(alive(pid)).toBe(true)
    vi.advanceTimersByTime(1)
    const err = await call
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(
      "the command didn't finish within 1.5 s, so run_command killed it and everything it started; " +
        'pass a larger timeout_ms if it needs longer, but a server or a watch mode never finishes, so run it in a way that does. ' +
        `What it printed before then:\nstarted\nwa\n[output cut at 10 bytes of 16; ${PIPE_HINT}]`,
    )
    await until(() => !alive(pid), 'the background job to die')
  })

  it('falls back to command_timeout_ms when the call sets no timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const call = settled(run({ command: 'sleep 30' }, { tools: { command_timeout_ms: 2000 } }))
    vi.advanceTimersByTime(2000)
    expect(String(await call)).toContain("didn't finish within 2 s, so run_command killed it")
  })

  it('takes a timeout of 1 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const call = settled(run({ command: 'sleep 30', timeout_ms: 1 }))
    vi.advanceTimersByTime(1)
    expect(String(await call)).toContain("didn't finish within 0.001 s")
  })

  it('holds a timeout past the longest Node timer to that timer, rather than letting it fire at once', async () => {
    await expect(run({ command: 'sleep 0.2; echo done', timeout_ms: 3_000_000_000 })).resolves.toBe(
      'done\n[exit code 0]',
    )
  })

  it('leaves no timer behind once a command finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await expect(run({ command: 'echo hi' })).resolves.toBe('hi\n[exit code 0]')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('kills the whole group when the turn is cancelled, leaving no grandchild alive, even one that ignores SIGTERM', async () => {
    const controller = new AbortController()
    // A signal the shell ignores stays ignored in everything it starts.
    const job = background_job('abort.pid', "trap '' TERM; ")
    const call = settled(run({ command: job.command }, { abort: controller.signal }))
    const pid = await job_pid(job.pid_file)
    const reason = new Error('the turn was cancelled')
    controller.abort(reason)
    expect(await call).toBe(reason)
    await until(() => !alive(pid), 'the background job to die')
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('starts nothing when the turn is already cancelled', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled before the call')
    controller.abort(reason)
    const marker = join(cwd, 'never.txt')
    await expect(run({ command: `touch ${marker}` }, { abort: controller.signal })).rejects.toBe(reason)
    expect(existsSync(marker)).toBe(false)
  })

  it('stops whatever a finished command left running in the background', async () => {
    const result = String(await run({ command: 'sleep 30 & echo $!' }))
    const [pid, ...rest] = result.split('\n')
    expect(rest).toEqual(['[exit code 0]'])
    await until(() => !alive(Number(pid)), 'the background job to die')
  })

  it('stops reading after a grace when something outside the group holds the output open, and says so', async () => {
    // The timeout is shorter than the grace, so this passes only if the
    // shell's exit stops the timeout from firing.
    const result = String(await run({ command: `'${process.execPath}' escape.cjs`, timeout_ms: 500 }))
    const [pid, ...rest] = result.split('\n')
    try {
      expect(rest).toEqual(['[exit code 0]', HELD_NOTE])
      expect(alive(Number(pid))).toBe(true)
    } finally {
      process.kill(-Number(pid), 'SIGKILL')
    }
  })

  it('inherits the agent environment by default, and runs with only what command_env gives it', async () => {
    vi.stubEnv('FASCICLE_RUN_COMMAND_PROBE', 'inherited')
    const command = 'echo "${FASCICLE_RUN_COMMAND_PROBE-unset} ${ONLY-unset}"'
    await expect(run({ command })).resolves.toBe('inherited unset\n[exit code 0]')
    await expect(run({ command }, { tools: { command_env: { ONLY: 'given' } } })).resolves.toBe(
      'unset given\n[exit code 0]',
    )
  })

  it('refuses on Windows, where read_file still works', async () => {
    const original = process.platform
    const marker = join(cwd, 'windows.txt')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      await expect(run({ command: `touch ${marker}` })).rejects.toThrow(
        "run_command runs commands through /bin/sh in a process group of their own, which Windows doesn't have, " +
          'so it can only refuse here; read_file, list_files, search, write_file, and edit_file still work',
      )
      const read = tool_named('read_file')
      await expect(
        read.execute({ path: 'notes.md' }, { abort: new AbortController().signal, tool_call_id: 'call-2', step_index: 0 }),
      ).resolves.toBe('     1\tone')
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
    expect(existsSync(marker)).toBe(false)
  })

  it('fails with what to check when the shell cannot start in cwd, and leaves no timer behind', async () => {
    const gone = join(base, 'gone')
    await mkdir(gone)
    const over = await session_over(gone)
    await rm(gone, { recursive: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const err = await settled(run({ command: 'true' }, { over }))
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(
      `run_command couldn't start /bin/sh in ${gone} (spawn /bin/sh ENOENT); the workspace may have been moved or deleted`,
    )
    expect((err as Error).cause).toMatchObject({ code: 'ENOENT' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['no input', null, 'run_command needs a command, as a string'],
    ['no command', {}, 'run_command needs a command, as a string'],
    ['a command that is not a string', { command: ['ls'] }, 'run_command needs a command, as a string'],
    ['a zero timeout', { command: 'true', timeout_ms: 0 }, 'run_command counts timeout_ms in milliseconds'],
    ['a fractional timeout', { command: 'true', timeout_ms: 1.5 }, 'run_command counts timeout_ms in milliseconds'],
    ['a timeout as a string', { command: 'true', timeout_ms: '100' }, 'run_command counts timeout_ms in milliseconds'],
  ])('refuses %s', async (_, input, message) => {
    await expect(run(input)).rejects.toThrow(message)
  })
})
