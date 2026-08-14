/**
 * In-process coverage for `start_viewer`.
 *
 * `cli.test.ts` mocks `start_viewer` entirely, so this composition over the
 * already-tested server and tail seams was previously only exercised via the
 * built bundle in a subprocess — invisible to in-process coverage. These
 * tests boot the real thing on an ephemeral port (`port: 0`, never a fixed
 * port) and drive both the tail-enabled and tail-less paths through to a
 * clean `close()`.
 */

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { start_viewer, type ViewerHandle } from '../start_viewer.js'

let work_dir = ''
let handle: ViewerHandle | null = null

afterEach(async () => {
  if (handle) await handle.close()
  handle = null
  if (work_dir) rmSync(work_dir, { recursive: true, force: true })
  work_dir = ''
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function snapshot(url: string): Promise<Array<{ event: { kind: string } }>> {
  const res = await fetch(`${url}/api/snapshot`)
  const body = (await res.json()) as { events: Array<{ event: { kind: string } }> }
  return body.events
}

async function wait_for_snapshot(
  url: string,
  predicate: (events: Array<{ event: { kind: string } }>) => boolean,
): Promise<Array<{ event: { kind: string } }>> {
  const deadline = Date.now() + 2000
  let events = await snapshot(url)
  while (Date.now() < deadline && !predicate(events)) {
    await wait(20)
    events = await snapshot(url)
  }
  return events
}

describe('start_viewer', () => {
  it('boots an HTTP server on an ephemeral port with no tail by default', async () => {
    handle = await start_viewer({ port: 0 })
    expect(handle.host).toBe('127.0.0.1')
    expect(handle.port).toBeGreaterThan(0)
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`)
    const res = await fetch(`${handle.url}/api/health`)
    expect(res.status).toBe(200)
  })

  it('passes on_subscriber_error through to the broadcaster without affecting boot', async () => {
    const errors: unknown[] = []
    handle = await start_viewer({ port: 0, on_subscriber_error: (err) => errors.push(err) })
    const res = await fetch(`${handle.url}/api/health`)
    expect(res.status).toBe(200)
    expect(errors).toEqual([])
  })

  it('tails a file when path is given, feeding events into the broadcaster the server reads', async () => {
    work_dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-start-'))
    const path = join(work_dir, 'events.jsonl')
    writeFileSync(path, `${JSON.stringify({ kind: 'emit', text: 'one' })}\n`)

    handle = await start_viewer({ path, port: 0, buffer: 50 })
    const events = await wait_for_snapshot(handle.url, (e) => e.length > 0)
    expect(events.map((e) => e.event.kind)).toEqual(['emit'])
  })

  it('routes malformed tail lines to on_parse_error', async () => {
    work_dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-start-'))
    const path = join(work_dir, 'events.jsonl')
    writeFileSync(path, 'not json\n')
    const parse_errors: string[] = []
    handle = await start_viewer({
      path,
      port: 0,
      on_parse_error: (_err, line) => parse_errors.push(line),
    })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && parse_errors.length === 0) await wait(20)
    expect(parse_errors).toEqual(['not json'])
  })

  it('routes a missing tail path to on_io_error', async () => {
    work_dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-start-'))
    const path = join(work_dir, 'does-not-exist.jsonl')
    const io_errors: unknown[] = []
    handle = await start_viewer({ path, port: 0, on_io_error: (err) => io_errors.push(err) })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && io_errors.length === 0) await wait(20)
    expect(io_errors.length).toBeGreaterThan(0)
  })

  it('close() stops both the tail and the server, leaking neither', async () => {
    work_dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-start-'))
    const path = join(work_dir, 'events.jsonl')
    writeFileSync(path, '')
    const local = await start_viewer({ path, port: 0 })
    const url = local.url

    await local.close()
    handle = null

    await expect(fetch(`${url}/api/health`)).rejects.toThrow()
    // A watcher left open would still pick this up; there is nothing left to
    // observe it, but the append must not throw or hang the process.
    appendFileSync(path, `${JSON.stringify({ kind: 'emit', text: 'late' })}\n`)
    await wait(50)
  })

  it('close() is safe when no tail was started', async () => {
    const local = await start_viewer({ port: 0 })
    await local.close()
    handle = null
    await expect(fetch(`${local.url}/api/health`)).rejects.toThrow()
  })
})
