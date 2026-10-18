/**
 * End-to-end wiring between `http_logger` and the viewer's ingest route.
 *
 * The CLI mounts `/api/ingest` only under `--listen`, which it does by
 * passing `ingest: true` to `start_viewer` (pinned in the CLI tests). These
 * runs start the viewer that way and log a real run through `http_logger`, so
 * the content type the logger sends and the ones the route reads, and the
 * `Host` the logger's URL carries and the ones the server answers, can't drift
 * apart unnoticed.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { run, step } from '#core'
import { http_logger } from '#adapters'
import { start_viewer } from '#viewer'
import type { ViewerHandle } from '#viewer'

let handle: ViewerHandle | null = null

afterEach(async () => {
  if (handle) await handle.close()
  handle = null
})

/** The kinds of the events in a viewer's ring buffer, oldest first. */
async function kinds(url: string): Promise<string[]> {
  const res = await fetch(`${url}/api/snapshot`)
  const body = (await res.json()) as { events: Array<{ event: { kind: string } }> }
  return body.events.map((entry) => entry.event.kind)
}

/** Poll a viewer's ring until `done` holds for its kinds, or two seconds pass. */
async function settle(url: string, done: (seen: string[]) => boolean): Promise<string[]> {
  const deadline = Date.now() + 2000
  let seen = await kinds(url)
  while (Date.now() < deadline && !done(seen)) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    seen = await kinds(url)
  }
  return seen
}

describe('http_logger into the viewer', () => {
  it('carries a run from http_logger into a viewer that takes ingest, as --listen starts it', async () => {
    handle = await start_viewer({ port: 0, ingest: true })
    const errors: unknown[] = []
    const trajectory = http_logger({ url: `${handle.url}/api/ingest`, on_error: (err) => errors.push(err) })
    await run(step('greet', (name: string) => `hello ${name}`), 'viewer', { trajectory })
    const seen = await settle(handle.url, (current) => current.includes('span_end'))
    expect(seen).toContain('span_start')
    expect(seen).toContain('span_end')
    expect(errors).toEqual([])
  })

  it('reports a 404 through on_error when the viewer only tails a file', async () => {
    handle = await start_viewer({ port: 0, ingest: false })
    const errors: unknown[] = []
    const trajectory = http_logger({ url: `${handle.url}/api/ingest`, on_error: (err) => errors.push(err) })
    trajectory.record({ kind: 'emit', text: 'nobody listening' })
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && errors.length === 0) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(errors.map((err) => String(err))).toEqual([`Error: http_logger: POST ${handle.url}/api/ingest -> 404`])
    expect(await kinds(handle.url)).toEqual([])
  })
})
