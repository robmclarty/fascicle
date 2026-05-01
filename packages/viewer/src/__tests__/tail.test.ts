import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ParsedTrajectoryEvent } from '@repo/core'
import { start_tail } from '../tail.js'

let work_dir = ''

beforeEach(() => {
  work_dir = mkdtempSync(join(tmpdir(), 'fascicle-viewer-tail-'))
})

afterEach(() => {
  rmSync(work_dir, { recursive: true, force: true })
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('start_tail', () => {
  it('parses initial lines from an existing file', async () => {
    const path = join(work_dir, 'a.jsonl')
    writeFileSync(
      path,
      [
        JSON.stringify({ kind: 'span_start', span_id: 's1', name: 'step' }),
        JSON.stringify({ kind: 'span_end', span_id: 's1' }),
      ].join('\n') + '\n',
    )
    const events: ParsedTrajectoryEvent[] = []
    const tail = start_tail({ path, on_event: (e) => events.push(e) })
    await tail.drain()
    tail.stop()
    expect(events).toHaveLength(2)
    expect(events[0]?.kind).toBe('span_start')
    expect(events[1]?.kind).toBe('span_end')
  })

  it('picks up appended lines after the watcher fires', async () => {
    const path = join(work_dir, 'b.jsonl')
    writeFileSync(path, '')
    const events: ParsedTrajectoryEvent[] = []
    const tail = start_tail({ path, on_event: (e) => events.push(e) })
    await tail.drain()

    appendFileSync(path, JSON.stringify({ kind: 'emit', span_id: 's1', text: 'hi' }) + '\n')
    await wait(50)
    await tail.drain()
    tail.stop()
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('emit')
  })

  it('buffers a partial last line until the newline arrives', async () => {
    const path = join(work_dir, 'c.jsonl')
    writeFileSync(path, '{"kind":"emit","text":"hel')
    const events: ParsedTrajectoryEvent[] = []
    const tail = start_tail({ path, on_event: (e) => events.push(e) })
    await tail.drain()
    expect(events).toHaveLength(0)

    appendFileSync(path, 'lo"}\n')
    await wait(50)
    await tail.drain()
    tail.stop()
    expect(events).toHaveLength(1)
  })

  it('resets and re-streams from offset 0 when the file is truncated', async () => {
    const path = join(work_dir, 'd.jsonl')
    writeFileSync(
      path,
      JSON.stringify({ kind: 'emit', text: 'one' }) + '\n' + JSON.stringify({ kind: 'emit', text: 'two' }) + '\n',
    )
    const events: ParsedTrajectoryEvent[] = []
    const tail = start_tail({ path, on_event: (e) => events.push(e) })
    await tail.drain()
    expect(events).toHaveLength(2)

    truncateSync(path, 0)
    appendFileSync(path, JSON.stringify({ kind: 'emit', text: 'fresh' }) + '\n')
    await wait(50)
    await tail.drain()
    tail.stop()

    const fresh = events.filter((e) => e.kind === 'emit')
    expect(fresh.some((e) => (e as Record<string, unknown>)['text'] === 'fresh')).toBe(true)
  })

  it('reports malformed JSON lines via on_parse_error and keeps going', async () => {
    const path = join(work_dir, 'e.jsonl')
    writeFileSync(path, 'not json\n' + JSON.stringify({ kind: 'emit', text: 'ok' }) + '\n')
    const events: ParsedTrajectoryEvent[] = []
    const errors: unknown[] = []
    const tail = start_tail({
      path,
      on_event: (e) => events.push(e),
      on_parse_error: (err) => errors.push(err),
    })
    await tail.drain()
    tail.stop()
    expect(events).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })
})
