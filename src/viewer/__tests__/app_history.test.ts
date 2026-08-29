/**
 * The full-history load: folding an `/api/trajectory` body and picking the
 * cursor SSE resumes from. All three helpers are pure functions over strings,
 * so the whole module runs here with no DOM and no server; the fetch that feeds
 * it is the Playwright suite's job.
 *
 * The fixture is the finished viewer-demo run (D8): folding its whole body must
 * reproduce the completed run, which is exactly what a client does when it opens
 * a finished `.jsonl` with no live producer (D7).
 *
 * Equivalent-mutant ledger (survivors left after this suite, classified here
 * rather than chased):
 *   - `if (line.length === 0) continue` -> `false` in `fold_history`: a blank
 *     line that skips the guard reaches `parse_frame('')`, which returns null,
 *     and the very next line drops it. The guard is a fast path, not a branch
 *     the count can take.
 *   - `if (value === null) return 0` -> `false` in `read_cursor_header`:
 *     `Number.parseInt(null, 10)` is `NaN`, which the `Number.isFinite` check
 *     below turns into the same 0. The guard exists for the type, not a value a
 *     header can carry.
 *   - `head > 0` -> `head >= 0` in `read_cursor_header`: the two differ only at
 *     `head === 0`, which returns 0 down either branch.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CURSOR_HEADER, events_url, fold_history, read_cursor_header } from '../app/history.js'
import { EMPTY_SESSION } from '../app/lib/scene.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(join(HERE, 'fixtures', 'fixture.trajectory.jsonl'), 'utf8')
const FIXTURE_EVENTS = FIXTURE.split('\n').filter((line) => line.length > 0).length

describe('fold_history', () => {
  it('exposes the header literal the route stamps', () => {
    expect(CURSOR_HEADER).toBe('x-fascicle-cursor')
  })

  it('folds the whole fixture into the completed run', () => {
    const history = fold_history(FIXTURE, 0)
    expect(history.count).toBe(FIXTURE_EVENTS)
    expect(history.session.structure).not.toBeNull()
    expect(history.session.state.run_id).toBe('42b20e54-41e6-47b2-8697-bda677867762')
    // A finished run has resolved its terminus, which is what freezes the clock.
    expect(history.session.state.run_status).not.toBeNull()
    expect(history.session.state.scars).toBe(1)
  })

  it('drops blank and undecodable lines exactly as the tail does', () => {
    const body = ['', '{"kind":"emit"}', 'not json', '{"kind":"emit"}', ''].join('\n')
    const history = fold_history(body, 0)
    expect(history.count).toBe(2)
  })

  it('takes the folded count as the cursor when it leads the stamped head', () => {
    // A file tail that lagged its own file: the dump carried events the
    // broadcaster had not, so the count is the true seam.
    expect(fold_history('{"kind":"emit"}\n{"kind":"emit"}\n', 0).cursor).toBe(2)
    expect(fold_history('{"kind":"emit"}\n{"kind":"emit"}\n', 1).cursor).toBe(2)
  })

  it('takes the stamped head as the cursor when the ring evicted history', () => {
    // Ingest past the ring buffer: the client folded fewer events than the
    // broadcaster ever emitted, so the head is the true seam.
    expect(fold_history('{"kind":"emit"}\n', 500).cursor).toBe(500)
  })

  it('folds an empty body to the empty session with a head-only cursor', () => {
    const history = fold_history('', 7)
    expect(history.count).toBe(0)
    expect(history.session).toBe(EMPTY_SESSION)
    expect(history.cursor).toBe(7)
  })
})

describe('read_cursor_header', () => {
  it('reads a positive integer', () => {
    expect(read_cursor_header('42')).toBe(42)
  })

  it('returns 0 for a missing, zero, negative, or non-numeric header', () => {
    expect(read_cursor_header(null)).toBe(0)
    expect(read_cursor_header('0')).toBe(0)
    expect(read_cursor_header('-3')).toBe(0)
    expect(read_cursor_header('nope')).toBe(0)
  })
})

describe('events_url', () => {
  it('appends the since cursor once history has been folded', () => {
    expect(events_url(42)).toBe('/api/events?since=42')
  })

  it('opens the plain stream when nothing was folded', () => {
    expect(events_url(0)).toBe('/api/events')
  })
})
