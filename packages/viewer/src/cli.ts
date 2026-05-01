#!/usr/bin/env tsx
/**
 * fascicle-viewer CLI.
 *
 *   fascicle-viewer <path>           # tail a JSONL file (primary)
 *   fascicle-viewer --listen          # accept HTTP push only
 *   fascicle-viewer <path> --listen   # both producers feed the same broadcaster
 *
 * Flags: --port <n> --host <h> --buffer <n> --no-open --help
 *
 * Defaults bind 127.0.0.1:4242 and open the user's default browser. SIGINT
 * shuts everything down cleanly.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { start_viewer } from './index.js'

type CliArgs = {
  readonly path?: string
  readonly host: string
  readonly port: number
  readonly buffer: number
  readonly listen: boolean
  readonly open: boolean
}

const HELP = `\
fascicle-viewer — minimal in-repo dashboard for fascicle trajectory streams.

Usage:
  fascicle-viewer <path>             tail a JSONL file
  fascicle-viewer --listen           accept HTTP push only
  fascicle-viewer <path> --listen    both producers feed the same broadcaster

Options:
  --port <n>      port (default 4242)
  --host <h>      bind host (default 127.0.0.1; --host 0.0.0.0 warns)
  --buffer <n>   ring-buffer size (default 1000)
  --no-open       do not open the browser
  --help          show this message
`

function parse(argv: readonly string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      port: { type: 'string', default: '4242' },
      host: { type: 'string', default: '127.0.0.1' },
      buffer: { type: 'string', default: '1000' },
      listen: { type: 'boolean', default: false },
      open: { type: 'boolean', default: true },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  const port_raw = values.port ?? '4242'
  const buffer_raw = values.buffer ?? '1000'
  const port = Number.parseInt(port_raw, 10)
  const buffer = Number.parseInt(buffer_raw, 10)
  if (!Number.isFinite(port) || port <= 0) {
    process.stderr.write(`invalid --port: ${port_raw}\n`)
    process.exit(2)
  }
  if (!Number.isFinite(buffer) || buffer <= 0) {
    process.stderr.write(`invalid --buffer: ${buffer_raw}\n`)
    process.exit(2)
  }
  const path = positionals[0]
  const listen = values.listen ?? false
  if (path === undefined && !listen) {
    process.stderr.write('fascicle-viewer: a <path> is required unless --listen is set\n')
    process.stderr.write(HELP)
    process.exit(2)
  }
  return {
    ...(path !== undefined ? { path } : {}),
    host: values.host ?? '127.0.0.1',
    port,
    buffer,
    listen,
    open: !values['no-open'] && (values.open ?? true),
  }
}

function open_browser(url: string): void {
  const platform = process.platform
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Best-effort. The CLI logs the URL anyway.
  }
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2))

  if (args.path !== undefined && !existsSync(args.path)) {
    process.stderr.write(
      `fascicle-viewer: warning: ${args.path} does not exist yet — will pick up events once it is created\n`,
    )
  }
  if (args.host === '0.0.0.0') {
    process.stderr.write(
      'fascicle-viewer: warning: binding 0.0.0.0 — this dashboard has no auth and exposes whatever is in your trajectory stream\n',
    )
  }

  const handle = await start_viewer({
    ...(args.path !== undefined ? { path: args.path } : {}),
    host: args.host,
    port: args.port,
    buffer: args.buffer,
    on_parse_error: (err, line) => {
      const preview = line.length > 120 ? `${line.slice(0, 120)}…` : line
      process.stderr.write(
        `fascicle-viewer: skipped malformed line: ${preview}\n  ${describe_error(err)}\n`,
      )
    },
    on_io_error: (err) => {
      process.stderr.write(`fascicle-viewer: io error: ${describe_error(err)}\n`)
    },
  })

  if (args.path !== undefined) process.stderr.write(`watching ${args.path}\n`)
  if (args.listen || args.path === undefined) process.stderr.write(`listening for HTTP push on ${handle.url}/api/ingest\n`)
  process.stderr.write(`viewer at ${handle.url}\n`)

  if (args.open) open_browser(handle.url)

  const shutdown = async (): Promise<void> => {
    process.stderr.write('\nfascicle-viewer: shutting down\n')
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void shutdown() })
  process.on('SIGTERM', () => { void shutdown() })
}

function describe_error(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`fascicle-viewer: ${describe_error(err)}\n`)
  process.exit(1)
})
