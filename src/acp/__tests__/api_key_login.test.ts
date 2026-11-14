import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { api_key_login } from '../api_key_login.js'
import type { LoginTerminal } from '../api_key_login.js'

const scratch_dirs: string[] = []

/** A credentials path in a directory that doesn't exist yet, under a fresh temp directory. */
async function credentials_path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-login-'))
  scratch_dirs.push(dir)
  return join(dir, 'config', 'credentials.json')
}

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await Promise.all(scratch_dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/**
 * A terminal a test types into. It records what the login wrote and each
 * switch of raw mode.
 */
function fake_terminal(is_tty = true) {
  const input = new PassThrough()
  const written: string[] = []
  const raw: boolean[] = []
  const terminal: LoginTerminal = {
    input: Object.assign(input, {
      isTTY: is_tty,
      setRawMode: (mode: boolean) => {
        raw.push(mode)
      },
    }),
    output: {
      write: (text: string) => {
        written.push(text)
      },
    },
  }
  return { terminal, type: (text: string) => input.write(text), written, raw }
}

async function login(env: Record<string, string | undefined> = {}) {
  const file = await credentials_path()
  return { file, ...api_key_login({ name: 'Example API key', variable: 'EXAMPLE_API_KEY', file, env }) }
}

describe('api_key_login: key', () => {
  it('finds no key with neither the variable nor the file', async () => {
    const { key, auth } = await login()
    expect(key()).toBeUndefined()
    expect(await auth.ready()).toBe(false)
  })

  it('reads the variable before the file, and the file when the variable is unset or empty', async () => {
    const file = await credentials_path()
    const terminal = fake_terminal()
    const from_file = api_key_login({ name: 'Example API key', variable: 'EXAMPLE_API_KEY', file, env: { EXAMPLE_API_KEY: '' } })
    const done = from_file.run(terminal.terminal)
    terminal.type('from-the-file\r')
    await done
    expect(from_file.key()).toBe('from-the-file')
    expect(await from_file.auth.ready()).toBe(true)
    const from_env = api_key_login({ name: 'Example API key', variable: 'EXAMPLE_API_KEY', file, env: { EXAMPLE_API_KEY: 'from-the-env' } })
    expect(from_env.key()).toBe('from-the-env')
    expect(api_key_login({ name: 'Example API key', variable: 'EXAMPLE_API_KEY', file, env: {} }).key()).toBe('from-the-file')
  })

  it.each(['not json', '{"api_key": 3}', '{"api_key": ""}', '["a key"]', '{}'])('finds no key in a file holding %s', async (text) => {
    const { file, key, run } = await login()
    const terminal = fake_terminal()
    const done = run(terminal.terminal)
    terminal.type('a-key\n')
    await done
    await writeFile(file, text)
    expect(key()).toBeUndefined()
  })
})

describe('api_key_login: auth', () => {
  it('names the variable and the login in what it tells the user, and logs in under --login', async () => {
    const { file, auth } = await login()
    expect(auth).toMatchObject({
      name: 'Example API key',
      description: `Reads EXAMPLE_API_KEY, or a key kept in ${file}`,
      instructions: "set EXAMPLE_API_KEY in the agent server's env, or run the agent with --login in a terminal to enter a key",
      terminal_args: ['--login'],
    })
  })

  it('forgets the stored key on logout, and resolves when there is none to forget', async () => {
    const { file, key, auth, run } = await login()
    await expect(auth.logout?.()).resolves.toBeUndefined()
    const terminal = fake_terminal()
    const done = run(terminal.terminal)
    terminal.type('a-key\r')
    await done
    expect(key()).toBe('a-key')
    await auth.logout?.()
    expect(key()).toBeUndefined()
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('api_key_login: run', () => {
  it('reads a key without echoing it, keeps it, and returns 0', async () => {
    const stdout = vi.spyOn(process.stdout, 'write')
    const stderr = vi.spyOn(process.stderr, 'write')
    const { file, key, run } = await login()
    const { terminal, type, written, raw } = fake_terminal()
    const done = run(terminal)
    type('sk-')
    type('secrex\u007Ft-key  \r')
    await expect(done).resolves.toBe(0)
    expect(key()).toBe('sk-secret-key')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ api_key: 'sk-secret-key' })
    expect(raw).toEqual([true, false])
    expect(written).toEqual(["Example API key (what you type isn't shown): ", '\n', `Example API key: saved to ${file}\n`])
    expect(written.join('')).not.toContain('secret')
    expect(stdout).not.toHaveBeenCalled()
    expect(stderr).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('writes the file for its owner alone, in a directory made for its owner alone', async () => {
    const { file, run } = await login()
    const { terminal, type } = fake_terminal()
    const done = run(terminal)
    type('a-key\n')
    await done
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(join(file, '..'))).mode & 0o777).toBe(0o700)
  })

  it('stops reading at Enter, so what is typed after it is no part of the key', async () => {
    const { key, run } = await login()
    const { terminal, type } = fake_terminal()
    const done = run(terminal)
    type('first\rsecond\r')
    await done
    expect(key()).toBe('first')
  })

  it('returns 1 without a terminal, and says to run it in one or set the variable', async () => {
    const { file, run } = await login()
    const { terminal, written, raw } = fake_terminal(false)
    await expect(run(terminal)).resolves.toBe(1)
    expect(written).toEqual([
      'Example API key: this login needs a terminal to read the key from; run it in one, or set EXAMPLE_API_KEY instead\n',
    ])
    expect(raw).toEqual([])
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['an empty line', '\r'],
    ['only spaces', '   \n'],
    ['Ctrl-C', 'half\u0003'],
    ['Ctrl-D', '\u0004'],
    ['a key backspaced away', 'ab\b\u007F\r'],
  ])('returns 1 and keeps nothing for %s', async (_, typed) => {
    const { file, run } = await login()
    const { terminal, type, written, raw } = fake_terminal()
    const done = run(terminal)
    type(typed)
    await expect(done).resolves.toBe(1)
    expect(written.at(-1)).toBe('Example API key: no key was entered, so nothing was saved; run the login again to enter one\n')
    expect(raw).toEqual([true, false])
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
