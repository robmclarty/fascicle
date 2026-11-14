/**
 * api_key_login: a login that keeps one API key in a file only the user can
 * read.
 *
 * Every agent that runs on a provider's API key needs the same login, so
 * this is it. The key comes from an environment variable first, so a key in
 * the client's agent server entry keeps working, and then from the file. A
 * client that can run a terminal login runs the agent's own command with
 * `--login`, where `run` asks for the key without echoing it and writes the
 * file. The agent's entry point calls `run` before it serves, so
 * `serve_acp` never reads a terminal.
 *
 * The file holds the key in plain text, as `~/.aws/credentials` does, in a
 * directory made for its owner alone (mode 0700) and readable by its owner
 * alone (mode 0600). The key never reaches a log, stdout, or the protocol:
 * the prompt and every message go to the terminal's own output, and none of
 * them carries it.
 *
 * The environment and the path are accepted at construction; this module
 * never reads `process.env`.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { is_record } from '#schema'
import type { AcpAuth } from './types.js'

export type ApiKeyLoginConfig = {
  /** What the client shows for the login, such as `'OpenRouter API key'`. */
  readonly name: string
  /** The environment variable read first, such as `'OPENROUTER_API_KEY'`. */
  readonly variable: string
  /** Where a key entered at the terminal is kept. */
  readonly file: string
  /** The environment `variable` is read from, which an entry point passes as `process.env`. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * The terminal a login reads the key from. `process.stdin` and
 * `process.stderr` fit it, and stderr is the output to use, since stdout
 * belongs to whoever launched the command.
 */
export type LoginTerminal = {
  readonly input: {
    readonly isTTY?: boolean | undefined
    readonly setRawMode?: ((raw: boolean) => unknown) | undefined
    readonly on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
    readonly off: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown
    readonly resume?: (() => unknown) | undefined
    readonly pause?: (() => unknown) | undefined
  }
  readonly output: { readonly write: (text: string) => unknown }
}

export type ApiKeyLogin = {
  /** The key now: the variable when it's set, and the file otherwise. */
  readonly key: () => string | undefined
  /** The login for `serve_acp`'s `auth`, with a terminal login under `--login`. */
  readonly auth: AcpAuth
  /**
   * Reads a key at the terminal without echoing it, writes the file, and
   * resolves with the process's exit code: 0 once the key is kept, and 1
   * when the input isn't a terminal or no key was entered.
   */
  readonly run: (terminal: LoginTerminal) => Promise<number>
}

/** The argument an agent's entry point runs the terminal login under. */
const LOGIN_ARGUMENT = '--login'

/**
 * The key a credentials file holds, or undefined when the file is missing
 * or holds anything else.
 */
function stored_key(file: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const key = is_record(value) ? value['api_key'] : undefined
    return typeof key === 'string' && key !== '' ? key : undefined
  } catch {
    return undefined
  }
}

/**
 * Write the key to `file`, readable by its owner alone, in a directory made
 * for its owner alone. The key goes to a temporary sibling first and is
 * renamed into place, so a crash mid-write leaves the earlier file whole.
 */
function store_key(file: string, key: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ api_key: key })}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}

/**
 * Read one line from a terminal in raw mode, so nothing typed is echoed.
 * Resolves with the line at Enter, and with undefined at Ctrl-C or Ctrl-D.
 * Backspace removes the last character.
 */
function read_secret(terminal: LoginTerminal): Promise<string | undefined> {
  const { input } = terminal
  const { promise, resolve } = Promise.withResolvers<string | undefined>()
  let typed = ''
  const on_data = (chunk: Buffer | string): void => {
    for (const character of chunk.toString()) {
      if (character === '\r' || character === '\n') return resolve(typed)
      if (character === '\u0003' || character === '\u0004') return resolve(undefined)
      if (character === '\u007F' || character === '\b') typed = typed.slice(0, -1)
      else typed += character
    }
  }
  input.setRawMode?.(true)
  input.on('data', on_data)
  input.resume?.()
  return promise.finally(() => {
    input.off('data', on_data)
    input.setRawMode?.(false)
    input.pause?.()
  })
}

/**
 * Build a login that keeps one API key: `key` reads it, `auth` goes to
 * `serve_acp`, and `run` is the terminal login the agent's entry point runs
 * under `--login`.
 */
export function api_key_login(config: ApiKeyLoginConfig): ApiKeyLogin {
  const { name, variable, file, env } = config
  const key = (): string | undefined => {
    const from_env = env[variable]
    return from_env !== undefined && from_env !== '' ? from_env : stored_key(file)
  }
  return {
    key,
    auth: {
      name,
      description: `Reads ${variable}, or a key kept in ${file}`,
      ready: () => key() !== undefined,
      instructions: `set ${variable} in the agent server's env, or run the agent with ${LOGIN_ARGUMENT} in a terminal to enter a key`,
      terminal_args: [LOGIN_ARGUMENT],
      logout: async () => {
        rmSync(file, { force: true })
      },
    },
    run: async (terminal) => {
      const say = (text: string): void => {
        terminal.output.write(text)
      }
      if (terminal.input.isTTY !== true) {
        say(`${name}: this login needs a terminal to read the key from; run it in one, or set ${variable} instead\n`)
        return 1
      }
      say(`${name} (what you type isn't shown): `)
      const entered = (await read_secret(terminal))?.trim()
      say('\n')
      if (entered === undefined || entered === '') {
        say(`${name}: no key was entered, so nothing was saved; run the login again to enter one\n`)
        return 1
      }
      store_key(file, entered)
      say(`${name}: saved to ${file}\n`)
      return 0
    },
  }
}
