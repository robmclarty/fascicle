/**
 * run_command: run a shell command in the workspace and hand back what it
 * printed and how it ended.
 *
 * The command is a string the model wrote in POSIX shell, so it runs as
 * `/bin/sh -c`, which behaves the same on every host and needs no read of
 * the user's `$SHELL`. Windows has neither that shell nor POSIX process
 * groups, so there the tool refuses and the file tools carry on.
 *
 * Each command leads a process group of its own, so the whole tree it starts
 * dies together: when the turn is cancelled, when it runs past its timeout,
 * and when the shell exits, which stops whatever it left running in the
 * background. Without that last kill, a job left behind would outlive the
 * call, and then the agent, since nothing would ever abort it. A command
 * that moves work into a group of its own (`set -m` in an interactive
 * shell, or a daemon that starts its own session) takes that work out of
 * reach, as it would from a terminal's Ctrl-C.
 *
 * The file tools' containment doesn't bind a command: the shell reaches
 * anything the user can.
 *
 * This is the one file in `src/acp/` that may import `node:child_process`
 * (rules/no-child-process-outside-run-command.yml).
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { Tool } from '#engine'
import { as_record, json_schema_to_standard } from '#schema'
import type { AcpSession } from '../types.js'
import { record_preview } from './previews.js'
import type { CommandPreview } from './previews.js'

/** The shell every command runs in. */
const SHELL = '/bin/sh'

/**
 * The longest delay a Node timer keeps. A longer one fires after 1 ms
 * instead, so a longer timeout is held to this, about 24.8 days.
 */
const MAX_TIMER_MS = 2_147_483_647

/**
 * How long the output may stay open once the shell has exited and its group
 * has been killed. The group's processes are gone by then, so only
 * something moved out of the group can be holding it, and that could hold
 * it for good.
 */
const OUTPUT_GRACE_MS = 1000

/** How `run_command` runs one session's commands, from `workspace_tools`' options. */
export type CommandSettings = {
  /** How long a call may run, unless it sets its own `timeout_ms`. */
  readonly timeout_ms: number
  /** The most output a call returns, in bytes. */
  readonly output_limit_bytes: number
  /** The whole environment commands run with, or `undefined` to inherit the agent's. */
  readonly env: Readonly<Record<string, string>> | undefined
}

/** One command as the model asked for it. */
type CommandRequest = {
  readonly command: string
  readonly timeout_ms: number | undefined
}

/**
 * What a command printed, stdout and stderr together in the order they
 * arrived, up to `limit` bytes: the parts kept, the bytes they account
 * for, and every byte the command printed.
 */
type Capture = {
  readonly limit: number
  readonly parts: string[]
  kept: number
  total: number
}

/**
 * Whether a value counts milliseconds: a whole number of at least 1.
 */
function is_millis(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1
}

/**
 * Read the call's command and timeout out of its input. The tool loop has
 * already checked the types against the schema, but a flow that wraps the
 * tool can call `execute` directly, and the schema's `minimum` is advice to
 * the model rather than something the loop enforces.
 */
function command_request(input: unknown): CommandRequest {
  const fields: Record<string, unknown> = as_record(input) ?? {}
  const { command, timeout_ms } = fields
  if (typeof command !== 'string') throw new Error('run_command needs a command, as a string')
  if (timeout_ms !== undefined && !is_millis(timeout_ms)) {
    throw new Error('run_command counts timeout_ms in milliseconds, so it has to be a whole number of at least 1')
  }
  return { command, timeout_ms }
}

/**
 * Keep a chunk of output while the capture has room, cutting the chunk that
 * crosses the limit, and count every byte either way. The output goes on
 * being read past the limit, since a command blocked on a full pipe would
 * never finish.
 */
function take(capture: Capture, chunk: string): void {
  const size = Buffer.byteLength(chunk)
  const room = capture.limit - capture.kept
  capture.total += size
  // Stryker disable next-line ConditionalExpression,EqualityOperator: with no room left the cut below keeps an empty string and counts no bytes, so going on reads the same; the return only spares a copy of every chunk past the cap.
  if (room <= 0) return
  // A chunk that fits comes through whole. One cut at the limit can end
  // inside a character, whose partial bytes the decoder holds back.
  capture.parts.push(new StringDecoder().write(Buffer.from(chunk).subarray(0, room)))
  capture.kept += Math.min(size, room)
}

/**
 * What a command printed as the model reads it, without its trailing
 * whitespace, with a marker when it was cut, and a line saying so when it
 * printed nothing at all.
 */
function printed(capture: Capture): string[] {
  if (capture.total === 0) return ['[no output]']
  const lines = [capture.parts.join('').trimEnd()]
  if (capture.total > capture.kept) {
    lines.push(
      `[output cut at ${capture.limit} bytes of ${capture.total}; pipe the command through tail, head, or grep to see the part you need]`,
    )
  }
  return lines.filter((line) => line !== '')
}

/**
 * How a finished command ended, as its report's last line: its exit code,
 * or the signal that ended it. Node sets exactly one of the two.
 */
function ending(child: ChildProcess): string {
  return child.exitCode === null ? `[ended by ${String(child.signalCode)}]` : `[exit code ${child.exitCode}]`
}

/**
 * A command that ran to its end: what it printed, its process, and whether
 * something it moved out of its group held its output open.
 */
type Finished = {
  readonly capture: Capture
  readonly child: ChildProcess
  readonly held: boolean
}

/**
 * A finished command's report: what it printed, then how it ended, and a
 * note when something it moved out of its group held its output open and
 * was left running.
 */
function report({ capture, child, held }: Finished): string {
  const lines = [...printed(capture), ending(child)]
  if (held) {
    lines.push(
      '[the command exited, but something it moved out of its process group held its output open, so run_command stopped reading and left that running]',
    )
  }
  return lines.join('\n')
}

/**
 * A finished command as its card shows it: what it printed, with nothing in
 * place of an empty output, and its exit code or the signal that ended it.
 */
function command_preview({ capture, child }: Finished): CommandPreview {
  return {
    kind: 'command',
    output: capture.total === 0 ? '' : printed(capture).join('\n'),
    exit_code: child.exitCode,
    signal: child.signalCode,
  }
}

/**
 * The error a call that ran past its timeout fails with, carrying what the
 * command printed before it was killed.
 */
function timeout_error(capture: Capture, timeout_ms: number): Error {
  return new Error(
    `the command didn't finish within ${timeout_ms / 1000} s, so run_command killed it and everything it started; ` +
      'pass a larger timeout_ms if it needs longer, but a server or a watch mode never finishes, so run it in a way that does. ' +
      `What it printed before then:\n${printed(capture).join('\n')}`,
  )
}

/**
 * Kill a command's whole process group with SIGKILL, the one signal no
 * command can ignore. The turn's abort can be the agent's last act before
 * `serve_acp` exits, which leaves no later moment to follow a gentler
 * signal with this one.
 */
function kill_group(child: ChildProcess): void {
  // Stryker disable next-line ConditionalExpression: without a pid, process.kill throws on the NaN it's handed, and the catch below takes that the same way.
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // The group is gone: every process in it has exited.
  }
}

/**
 * Run one command to its end in its own process group. A command that ends
 * on its own is a result, whatever its exit code; a timeout and a shell that
 * won't start are errors, and the turn's abort rejects with its reason. The
 * timeout and the abort kill the group, and the shell's exit kills whatever
 * it left behind. Each reads on to the end of the output, so what the
 * command printed last isn't lost, until the grace after the shell's exit
 * runs out. However the call ends, its timers and the abort listener go
 * with it.
 */
async function run_shell(
  request: CommandRequest,
  cwd: string,
  settings: CommandSettings,
  abort: AbortSignal,
): Promise<Finished> {
  abort.throwIfAborted()
  const timeout_ms = request.timeout_ms ?? settings.timeout_ms
  const capture: Capture = { limit: settings.output_limit_bytes, parts: [], kept: 0, total: 0 }
  const child = spawn(SHELL, ['-c', request.command], {
    cwd,
    env: settings.env === undefined ? undefined : { ...settings.env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const { promise, resolve, reject } = Promise.withResolvers<Finished>()
  let timed_out = false
  let held = false
  let grace: NodeJS.Timeout | undefined
  const on_abort = (): void => {
    kill_group(child)
    reject(abort.reason)
  }
  for (const stream of [child.stdout, child.stderr]) {
    // Stryker disable next-line StringLiteral: Node reads an empty encoding name as UTF-8.
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      take(capture, chunk)
    })
  }
  const timer = setTimeout(() => {
    timed_out = true
    kill_group(child)
  }, Math.min(timeout_ms, MAX_TIMER_MS))
  child.once('error', (err) => {
    reject(
      new Error(`run_command couldn't start ${SHELL} in ${cwd} (${err.message}); the workspace may have been moved or deleted`, {
        cause: err,
      }),
    )
  })
  child.once('exit', () => {
    clearTimeout(timer)
    kill_group(child)
    // Stopping the reads closes the call even while something still holds
    // the other end of the output open.
    grace = setTimeout(() => {
      held = true
      child.stdout.destroy()
      child.stderr.destroy()
    }, OUTPUT_GRACE_MS)
  })
  child.once('close', () => {
    if (timed_out) reject(timeout_error(capture, timeout_ms))
    else resolve({ capture, child, held })
  })
  abort.addEventListener('abort', on_abort)
  try {
    return await promise
  } finally {
    clearTimeout(timer)
    clearTimeout(grace)
    abort.removeEventListener('abort', on_abort)
  }
}

/**
 * The `run_command` tool for one session: a command run through the shell
 * in its `cwd`, with a timeout, an output cap, and the environment the
 * settings give it, its whole process tree killed when the turn is
 * cancelled. POSIX only: on Windows every call is refused.
 */
export function run_command_tool(session: AcpSession, settings: CommandSettings): Tool {
  return {
    name: 'run_command',
    description: [
      `Run a shell command with ${SHELL} -c in the workspace root, and return what it printed (stdout and stderr together) and its exit code.`,
      'Each call starts a fresh shell there, so a cd lasts for its own command only.',
      `The command is stopped after ${settings.timeout_ms / 1000} s unless timeout_ms says otherwise,`,
      `and output past ${settings.output_limit_bytes} bytes is cut, so pipe a long one through tail, head, or grep.`,
      "It gets no input, and anything it starts is stopped once it exits, so it can't leave a server or a watcher running.",
    ].join(' '),
    input_schema: json_schema_to_standard({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line, as you would type it in a POSIX shell' },
        timeout_ms: {
          type: 'integer',
          minimum: 1,
          description: `How long the command may run, in milliseconds; default: ${settings.timeout_ms}`,
        },
      },
      required: ['command'],
      additionalProperties: false,
    }),
    execute: async (input, ctx) => {
      if (process.platform === 'win32') {
        throw new Error(
          `run_command runs commands through ${SHELL} in a process group of their own, which Windows doesn't have, ` +
            'so it can only refuse here; read_file, list_files, search, write_file, and edit_file still work',
        )
      }
      const finished = await run_shell(command_request(input), session.cwd, settings, ctx.abort)
      record_preview(session, ctx.tool_call_id, command_preview(finished))
      return report(finished)
    },
  }
}
