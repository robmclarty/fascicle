/**
 * In-process coverage for the fascicle-viewer CLI.
 *
 * `cli.ts` is a bin entry whose only prior test drove the built bundle in a
 * subprocess, so the parse/orchestration/open paths were invisible to
 * in-process coverage. These tests exercise them directly: `parse` via a flag
 * matrix, `open_browser` across platforms with an injected `spawn`, and
 * `run_viewer_cli` with `start_viewer` mocked so no real server binds and no
 * real browser opens (viewer tests never spawn a browser or a fixed port).
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { open_browser, parse, run_viewer_cli } from '../cli.js'
import { start_viewer } from '../start_viewer.js'

vi.mock('../start_viewer.js', () => ({ start_viewer: vi.fn() }))

vi.mock('node:child_process', async (import_original) => {
  const actual = await import_original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

const spawn_mock = vi.mocked(spawn)
const start_viewer_mock = vi.mocked(start_viewer)
const child_mock = { on: vi.fn(), unref: vi.fn() }

const VIEWER_URL = 'http://127.0.0.1:4242'

/** Thrown in place of a real `process.exit` so control flow halts as it would. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

let stdout_text = ''
let stderr_text = ''
let exit_spy: ReturnType<typeof vi.spyOn>

const flush_async = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

beforeEach(() => {
  stdout_text = ''
  stderr_text = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout_text += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr_text += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  })
  exit_spy = vi.spyOn(process, 'exit')
  exit_spy.mockImplementation((code?: number): never => {
    throw new ExitSignal(code ?? 0)
  })

  spawn_mock.mockReset()
  spawn_mock.mockReturnValue(child_mock as never)
  child_mock.on.mockReset()
  child_mock.unref.mockReset()
  start_viewer_mock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Runs `parse`, expecting it to exit; returns the exit code it requested. */
function parse_exit(argv: readonly string[]): number {
  try {
    parse(argv)
  } catch (err) {
    if (err instanceof ExitSignal) return err.code
    throw err
  }
  throw new Error('expected parse to call process.exit')
}

describe('parse', () => {
  it('returns defaults for a bare path', () => {
    expect(parse(['events.jsonl'])).toStrictEqual({
      path: 'events.jsonl',
      host: '127.0.0.1',
      port: 4242,
      buffer: 1000,
      listen: false,
      open: true,
    })
  })

  it('honors every flag together', () => {
    expect(
      parse(['events.jsonl', '--port', '8080', '--host', 'example.com', '--buffer', '50', '--no-open']),
    ).toStrictEqual({
      path: 'events.jsonl',
      host: 'example.com',
      port: 8080,
      buffer: 50,
      listen: false,
      open: false,
    })
  })

  it('omits the path key entirely in listen mode', () => {
    const args = parse(['--listen'])
    expect(args).toStrictEqual({
      host: '127.0.0.1',
      port: 4242,
      buffer: 1000,
      listen: true,
      open: true,
    })
    expect('path' in args).toBe(false)
  })

  it('accepts a path alongside --listen', () => {
    expect(parse(['events.jsonl', '--listen'])).toStrictEqual({
      path: 'events.jsonl',
      host: '127.0.0.1',
      port: 4242,
      buffer: 1000,
      listen: true,
      open: true,
    })
  })

  it('prints usage and exits 0 on --help', () => {
    expect(parse_exit(['--help'])).toBe(0)
    expect(stdout_text).toContain('fascicle-viewer — minimal in-repo dashboard')
    expect(stdout_text).toContain('Usage:')
    expect(stderr_text).toBe('')
  })

  it.each([
    ['non-numeric', ['--port', 'abc'], 'invalid --port: abc'],
    ['zero', ['--port', '0'], 'invalid --port: 0'],
    ['negative', ['--port=-3'], 'invalid --port: -3'],
  ])('rejects a %s --port', (_label, argv, message) => {
    expect(parse_exit(argv)).toBe(2)
    expect(stderr_text).toContain(message)
  })

  it.each([
    ['non-numeric', ['events.jsonl', '--buffer', 'xyz'], 'invalid --buffer: xyz'],
    ['zero', ['events.jsonl', '--buffer', '0'], 'invalid --buffer: 0'],
  ])('rejects a %s --buffer', (_label, argv, message) => {
    expect(parse_exit(argv)).toBe(2)
    expect(stderr_text).toContain(message)
  })

  it('requires a path unless --listen is set', () => {
    expect(parse_exit([])).toBe(2)
    expect(stderr_text).toContain('a <path> is required unless --listen is set')
    expect(stderr_text).toContain('Usage:')
  })
})

describe('open_browser', () => {
  it.each([
    ['darwin', 'open', ['https://x.test']],
    ['linux', 'xdg-open', ['https://x.test']],
    ['win32', 'cmd', ['/c', 'start', '""', 'https://x.test']],
  ] as const)('spawns the %s opener detached', (platform, cmd, args) => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    try {
      open_browser('https://x.test')
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
    expect(spawn_mock).toHaveBeenCalledTimes(1)
    expect(spawn_mock).toHaveBeenCalledWith(cmd, args, { stdio: 'ignore', detached: true })
    expect(child_mock.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(child_mock.unref).toHaveBeenCalledTimes(1)
  })

  it('swallows a spawn failure so the CLI can still print the url', () => {
    spawn_mock.mockImplementationOnce(() => {
      throw new Error('no opener available')
    })
    expect(() => { open_browser('https://x.test') }).not.toThrow()
  })
})

describe('run_viewer_cli', () => {
  let tmp_dir: string
  let existing_file: string
  let close_spy: Mock<() => Promise<void>>
  let signal_handlers: Map<string | symbol, (...args: unknown[]) => void>

  beforeAll(() => {
    tmp_dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-cli-'))
    existing_file = join(tmp_dir, 'events.jsonl')
    writeFileSync(existing_file, '')
  })

  afterAll(() => {
    rmSync(tmp_dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    close_spy = vi.fn<() => Promise<void>>(async () => {})
    start_viewer_mock.mockResolvedValue({
      url: VIEWER_URL,
      host: '127.0.0.1',
      port: 4242,
      close: close_spy,
    })
    signal_handlers = new Map()
    vi.spyOn(process, 'on').mockImplementation((event: string | symbol, handler: (...args: unknown[]) => void) => {
      signal_handlers.set(event, handler)
      return process
    })
  })

  it('tails an existing path, logs, and opens the browser by default', async () => {
    await run_viewer_cli([existing_file])

    expect(start_viewer_mock).toHaveBeenCalledTimes(1)
    const opts = start_viewer_mock.mock.calls[0]?.[0]
    if (!opts) throw new Error('expected start_viewer to be called')
    expect(opts).toMatchObject({ path: existing_file, host: '127.0.0.1', port: 4242, buffer: 1000 })

    expect(stderr_text).toContain(`watching ${existing_file}`)
    expect(stderr_text).toContain(`viewer at ${VIEWER_URL}`)
    expect(stderr_text).not.toContain('listening for HTTP push')

    expect(spawn_mock).toHaveBeenCalledTimes(1)
    expect(spawn_mock.mock.calls[0]?.[1]).toContain(VIEWER_URL)
  })

  it('warns but proceeds when the tailed path does not exist yet', async () => {
    const missing = join(tmp_dir, 'not-created-yet.jsonl')
    await run_viewer_cli([missing])

    expect(stderr_text).toContain(`warning: ${missing} does not exist yet`)
    expect(start_viewer_mock).toHaveBeenCalledTimes(1)
  })

  it('warns when binding 0.0.0.0', async () => {
    await run_viewer_cli([existing_file, '--host', '0.0.0.0', '--no-open'])

    const opts = start_viewer_mock.mock.calls[0]?.[0]
    if (!opts) throw new Error('expected start_viewer to be called')
    expect(opts.host).toBe('0.0.0.0')
    expect(stderr_text).toContain('binding 0.0.0.0')
  })

  it('logs the ingest endpoint and passes no path in listen mode', async () => {
    await run_viewer_cli(['--listen', '--no-open'])

    const opts = start_viewer_mock.mock.calls[0]?.[0]
    if (!opts) throw new Error('expected start_viewer to be called')
    expect(opts.path).toBeUndefined()
    expect(stderr_text).toContain(`listening for HTTP push on ${VIEWER_URL}/api/ingest`)
    expect(stderr_text).not.toContain('watching')
  })

  it('does not open the browser with --no-open', async () => {
    await run_viewer_cli([existing_file, '--no-open'])
    expect(spawn_mock).not.toHaveBeenCalled()
  })

  it('registers SIGINT/SIGTERM handlers that close the viewer cleanly', async () => {
    exit_spy.mockImplementation((_code?: number) => undefined)
    await run_viewer_cli([existing_file, '--no-open'])

    expect(signal_handlers.has('SIGINT')).toBe(true)
    expect(signal_handlers.has('SIGTERM')).toBe(true)

    signal_handlers.get('SIGINT')?.()
    await flush_async()

    expect(stderr_text).toContain('shutting down')
    expect(close_spy).toHaveBeenCalledTimes(1)
    expect(exit_spy).toHaveBeenCalledWith(0)
  })

  it('wires parse-error and io-error handlers that describe the failure on stderr', async () => {
    await run_viewer_cli([existing_file, '--no-open'])
    const opts = start_viewer_mock.mock.calls[0]?.[0]
    if (!opts) throw new Error('expected start_viewer to be called')

    opts.on_parse_error?.(new Error('bad json'), '{oops')
    expect(stderr_text).toContain('skipped malformed line: {oops')
    expect(stderr_text).toContain('bad json')

    const long_line = 'x'.repeat(200)
    opts.on_parse_error?.(new Error('too long'), long_line)
    expect(stderr_text).toContain(`${long_line.slice(0, 120)}…`)

    opts.on_parse_error?.('weird', 'a line')
    expect(stderr_text).toContain('"weird"')

    opts.on_io_error?.(new Error('disk gone'))
    expect(stderr_text).toContain('io error: disk gone')

    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    opts.on_io_error?.(circular)
    expect(stderr_text).toContain('[object Object]')
  })
})
