/**
 * The scrubber's timeline: the run read as a spine of time, and the index math
 * a scrub position resolves through.
 *
 * The design fixture drives the reference domain (the same run the artboards
 * freeze): its span is 196ms and its two error closes sit at T+113 and T+185.
 * The purity contract is the one the scrubber leans on (C5): the elapsed offset
 * the timeline stores for every event equals `t_plus_ms` of a fresh fold of that
 * prefix, and `session_at` equals incremental application, so the header the
 * playhead reads and the canvas the eye reads can never fall out of step.
 * Synthetic timelines pin the position and stepping math the fixture's shape
 * does not exercise (a degenerate domain, a sparse clock, the run's ends).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { FlowNode } from '#core'
import { reduce, t_plus_ms } from '../app/lib/reduce.js'
import { EMPTY_SESSION, apply_frame } from '../app/lib/scene.js'
import {
  build_timeline,
  density_bins,
  fraction_at,
  index_at_fraction,
  scrub_key,
  session_at,
  step_event,
  step_second,
  type Timeline,
} from '../app/lib/timeline.js'
import type { ViewerFrame } from '../app/sse.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const lines = readFileSync(join(HERE, 'fixtures', 'fixture.trajectory.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)

const events: unknown[] = lines.map((line) => JSON.parse(line) as unknown)
const frames = events as ViewerFrame[]
const structure = (events[0] as { structure: FlowNode }).structure

/** The run's span and its two failure offsets, off the fixture header numbers. */
const SPAN_MS = 196
const FIRST_FAIL_MS = 113
const SECOND_FAIL_MS = 185

/** A sparse synthetic clock, for the position and stepping math in isolation. */
const SPARSE: Timeline = {
  count: 5,
  span_ms: 2500,
  times: [0, 100, 1000, 1100, 2500],
  failures: [],
}

describe('build_timeline over the fixture', () => {
  it('reads the run span off the fold clock', () => {
    const timeline = build_timeline(frames)
    expect(timeline.count).toBe(frames.length)
    expect(timeline.span_ms).toBe(SPAN_MS)
    expect(timeline.times[0]).toBe(0)
    expect(timeline.times.at(-1)).toBe(SPAN_MS)
  })

  it('marks each error close at its own moment on the spine', () => {
    const timeline = build_timeline(frames)
    expect(timeline.failures).toEqual([FIRST_FAIL_MS / SPAN_MS, SECOND_FAIL_MS / SPAN_MS])
  })
})

describe('build_timeline permissiveness (C7)', () => {
  it('is an empty spine for an empty log', () => {
    const timeline = build_timeline([])
    expect(timeline).toEqual({ count: 0, span_ms: 0, times: [], failures: [] })
  })

  it('holds the clock until the first usable ts, then measures from it', () => {
    const timeline = build_timeline([
      { kind: 'a', ts: Number.NaN },
      { kind: 'b', ts: 100 },
      { kind: 'c', ts: 300 },
    ] as ViewerFrame[])
    expect(timeline.times).toEqual([0, 0, 200])
    expect(timeline.span_ms).toBe(200)
  })

  it('seats a failure at fraction zero when the run has no span', () => {
    const timeline = build_timeline([
      { kind: 'span_start', span_id: 's', name: 'step', id: 'x', ts: 500 },
      { kind: 'span_end', span_id: 's', error: 'boom', ts: 500 },
    ] as ViewerFrame[])
    expect(timeline.span_ms).toBe(0)
    expect(timeline.failures).toEqual([0])
  })
})

describe('the purity contract (C5)', () => {
  it('stores the elapsed offset a fresh fold of the prefix reports', () => {
    const timeline = build_timeline(frames)
    for (let index = 0; index < frames.length; index += 1) {
      expect(timeline.times[index]).toBe(
        t_plus_ms(reduce(structure, frames.slice(0, index + 1))),
      )
    }
  })

  it('folds any prefix to the state incremental application reached', () => {
    let session = EMPTY_SESSION
    const snapshots = [session]
    for (const frame of frames) {
      session = apply_frame(session, frame)
      snapshots.push(session)
    }
    for (let index = 0; index < frames.length; index += 1) {
      expect(session_at(frames, index)).toEqual(snapshots[index + 1])
    }
  })

  it('folds nothing before the first event and the whole run past the last', () => {
    expect(session_at(frames, -1)).toEqual(EMPTY_SESSION)
    const whole = session_at(frames, frames.length + 5)
    expect(whole.state.run_status).not.toBeNull()
    expect(whole.state.scars).toBe(1)
  })
})

describe('fraction_at', () => {
  it('spreads an event by its offset over the run span', () => {
    expect(fraction_at(SPARSE, 2)).toBe(1000 / 2500)
  })

  it('clamps an out-of-range index to the run ends', () => {
    expect(fraction_at(SPARSE, -3)).toBe(0)
    expect(fraction_at(SPARSE, 99)).toBe(1)
  })

  it('falls back to the index when the domain has no span', () => {
    const flat: Timeline = { count: 5, span_ms: 0, times: [0, 0, 0, 0, 0], failures: [] }
    expect(fraction_at(flat, 2)).toBe(0.5)
    expect(fraction_at({ count: 1, span_ms: 0, times: [0], failures: [] }, 0)).toBe(0)
    expect(fraction_at({ count: 0, span_ms: 0, times: [], failures: [] }, 0)).toBe(0)
  })
})

describe('index_at_fraction', () => {
  it('lands on the event nearest that moment in run time', () => {
    expect(index_at_fraction(SPARSE, 0)).toBe(0)
    expect(index_at_fraction(SPARSE, 1)).toBe(4)
    // 0.5 -> 1250ms: nearer 1100 (index 3) than 2500 (index 4).
    expect(index_at_fraction(SPARSE, 0.5)).toBe(3)
  })

  it('maps a fraction straight onto the index on a spanless domain', () => {
    const flat: Timeline = { count: 5, span_ms: 0, times: [0, 0, 0, 0, 0], failures: [] }
    expect(index_at_fraction(flat, 0.5)).toBe(2)
    expect(index_at_fraction({ count: 0, span_ms: 0, times: [], failures: [] }, 0.5)).toBe(0)
  })
})

describe('density_bins', () => {
  it('shades nothing for the empty log', () => {
    const empty: Timeline = { count: 0, span_ms: 0, times: [], failures: [] }
    expect(density_bins(empty, 4)).toEqual([0, 0, 0, 0])
  })

  it('lands a single event in the first bin at full strength', () => {
    const single: Timeline = { count: 1, span_ms: 0, times: [0], failures: [] }
    expect(density_bins(single, 4)).toEqual([1, 0, 0, 0])
  })

  it('spreads a zero-span run by event index, as the playhead walks it', () => {
    const flat: Timeline = { count: 5, span_ms: 0, times: [0, 0, 0, 0, 0], failures: [] }
    // Index fractions 0, .25, .5, .75, 1 land in bins 0, 1, 2, 3, 3.
    expect(density_bins(flat, 4)).toEqual([0.5, 0.5, 0.5, 1])
  })

  it('normalizes the busiest bin to full strength and clamps the last event in', () => {
    // Fractions 0, .04, .4, .44, 1 land in bins 0, 0, 2, 2, 4.
    expect(density_bins(SPARSE, 5)).toEqual([1, 0, 1, 0, 0.5])
  })
})

describe('step_event', () => {
  it('steps one event in the sign of the direction', () => {
    expect(step_event(2, 1, 5)).toBe(3)
    expect(step_event(2, 9, 5)).toBe(3)
    expect(step_event(2, -1, 5)).toBe(1)
  })

  it('clamps at the run ends', () => {
    expect(step_event(4, 1, 5)).toBe(4)
    expect(step_event(0, -1, 5)).toBe(0)
    expect(step_event(0, 1, 0)).toBe(0)
  })
})

describe('step_second', () => {
  it('clears a full second forward to the first event past it', () => {
    expect(step_second(SPARSE, 0, 1)).toBe(2)
    expect(step_second(SPARSE, 4, 1)).toBe(4)
  })

  it('clears a full second backward to the first event before it', () => {
    expect(step_second(SPARSE, 4, -1)).toBe(3)
    expect(step_second(SPARSE, 0, -1)).toBe(0)
  })

  it('has nothing to step on an empty spine', () => {
    expect(step_second({ count: 0, span_ms: 0, times: [], failures: [] }, 0, 1)).toBe(0)
  })
})

describe('scrub_key (Q5)', () => {
  it('steps one event on a bare arrow', () => {
    expect(scrub_key(SPARSE, 1, 'ArrowRight', false)).toBe(2)
    expect(scrub_key(SPARSE, 1, 'ArrowLeft', false)).toBe(0)
  })

  it('steps one second on a modified arrow', () => {
    expect(scrub_key(SPARSE, 0, 'ArrowRight', true)).toBe(2)
    expect(scrub_key(SPARSE, 4, 'ArrowLeft', true)).toBe(3)
  })

  it('rewinds to T+0 on Home and re-attaches to the edge on End', () => {
    expect(scrub_key(SPARSE, 3, 'Home', false)).toBe(0)
    expect(scrub_key(SPARSE, 3, 'End', false)).toBe('live')
  })

  it('ignores an unhandled key and an empty spine', () => {
    expect(scrub_key(SPARSE, 3, 'Enter', false)).toBe('ignore')
    const empty: Timeline = { count: 0, span_ms: 0, times: [], failures: [] }
    expect(scrub_key(empty, 0, 'ArrowRight', false)).toBe('ignore')
  })
})
