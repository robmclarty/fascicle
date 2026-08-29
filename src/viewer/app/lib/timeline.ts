/**
 * The scrubber's timeline: the run's event log read as a spine of time.
 *
 * Replay is a fold, not a second engine (C5). The canvas at any instant is
 * `reduce(structure, events[0..t])`, so the scrubber never needs its own state
 * machine: it needs a coordinate. This module is that coordinate. It reads the
 * frame log once into the run's time domain (first event to last), the elapsed
 * offset of every event, and the moments a span closed on an error, and it maps
 * a scrub position back to the event index whose prefix the fold should
 * recompute. `session_at` is the recompute, spelled with the same `apply_frame`
 * the live tail uses so a scrubbed frame and a streamed frame fold identically.
 *
 * The time coordinate is the fold's own clock, not a wall clock: the elapsed
 * offset stored for event `i` is `last_ts - t0` after folding through `i`, which
 * is exactly what `t_plus_ms` reports for that prefix. The app_timeline suite
 * pins the two equal at every index, so the playhead the header reads and the
 * spine the eye reads can never disagree. Nothing here touches a clock or the
 * DOM, which keeps the whole module a pure fold the node suite covers.
 *
 * A degenerate domain (one event, or a run whose events all share a ts) has no
 * time to spread across, so positions fall back to the event index instead of
 * dividing by a zero span. The wire reading stays permissive for the reason the
 * fold does (C7): an event without a usable ts leaves the clock where it was.
 */

import { EMPTY_SESSION, apply_frame, type Session } from './scene.js'
import type { ViewerFrame } from '../sse.js'

/**
 * The run laid out as a spine of time. `times` is the fold's elapsed clock at
 * every event index; `span_ms` is its last value, the whole run's duration;
 * `failures` are the spine fractions of each error close, the marks the spine
 * always draws. `count` is the number of folded events, which is also the live
 * edge (the newest event's index is `count - 1`).
 */
export type Timeline = {
  readonly count: number
  readonly span_ms: number
  readonly times: ReadonlyArray<number>
  readonly failures: ReadonlyArray<number>
}

/**
 * Scan the frame log into the timeline. One pass tracks the fold's clock (first
 * usable ts to newest usable ts) and records the elapsed offset after each
 * event, so `times[i]` matches `t_plus_ms(session_at(frames, i))` exactly. An
 * error close records its own offset as a failure, turned into a spine fraction
 * once the span is known.
 */
export function build_timeline(frames: ReadonlyArray<ViewerFrame>): Timeline {
  let t0: number | null = null
  let last: number | null = null
  const times: number[] = []
  const failure_times: number[] = []
  for (const frame of frames) {
    const ts = read_ts(frame)
    if (ts !== null) {
      t0 ??= ts
      last = ts
    }
    const elapsed = t0 === null || last === null ? 0 : Math.max(0, last - t0)
    times.push(elapsed)
    if (frame['kind'] === 'span_end' && frame['error'] !== undefined) {
      failure_times.push(elapsed)
    }
  }
  const span_ms = t0 === null || last === null ? 0 : Math.max(0, last - t0)
  return {
    count: times.length,
    span_ms,
    times,
    failures: failure_times.map((elapsed) => spine_fraction(elapsed, span_ms)),
  }
}

/**
 * The spine fraction of one event index: its elapsed offset over the run's
 * span. A run with no time to spread (a single event, or every event on the
 * same ts) has no fraction to compute, so the position falls back to the index
 * itself so the playhead still walks the events end to end.
 */
export function fraction_at(timeline: Timeline, index: number): number {
  const { times, span_ms, count } = timeline
  if (count === 0) return 0
  const i = clamp(index, 0, count - 1)
  if (span_ms > 0) return clamp((times[i] ?? 0) / span_ms, 0, 1)
  return count > 1 ? i / (count - 1) : 0
}

/**
 * The event index a spine fraction lands on: the event nearest that moment in
 * run time, so a drag or click settles on the closest real event rather than
 * an interpolated instant the fold has no state for. On a degenerate domain the
 * fraction maps straight onto the event index.
 */
export function index_at_fraction(timeline: Timeline, fraction: number): number {
  const { times, span_ms, count } = timeline
  if (count === 0) return 0
  const target = clamp(fraction, 0, 1)
  if (span_ms <= 0) return Math.round(target * (count - 1))
  return nearest_index(times, target * span_ms)
}

/** Step one event along the log (the arrow keys), clamped to the run's ends. */
export function step_event(index: number, direction: number, count: number): number {
  return clamp(index + Math.sign(direction), 0, Math.max(0, count - 1))
}

/**
 * Step one second of run time (the modified arrow keys): the first event a full
 * second past the current one in the chosen direction, or the run's end when no
 * event reaches that far. Landing on the first event past the second, rather
 * than the nearest, guarantees the playhead always clears the boundary instead
 * of stalling inside a dense burst.
 */
export function step_second(timeline: Timeline, index: number, direction: number): number {
  const { times, count } = timeline
  if (count === 0) return 0
  const i = clamp(index, 0, count - 1)
  const here = times[i] ?? 0
  if (direction > 0) {
    const target = here + 1000
    for (let j = i + 1; j < count; j += 1) if ((times[j] ?? 0) >= target) return j
    return count - 1
  }
  const target = here - 1000
  for (let j = i - 1; j >= 0; j -= 1) if ((times[j] ?? 0) <= target) return j
  return 0
}

/**
 * The scrub move a keydown selects (Q5): the arrows step one event, held with
 * Shift they step one second, Home rewinds to T+0, and End returns to the live
 * edge (`'live'`). A run with no events, or any other key, is `'ignore'` so the
 * caller leaves the page's own key handling alone. The mapping lives here, with
 * the stepping math it dispatches to, so the entry file stays a thin wire that
 * only forwards the result to state.
 */
export function scrub_key(
  timeline: Timeline,
  index: number,
  key: string,
  shift: boolean,
): number | 'live' | 'ignore' {
  if (timeline.count === 0) return 'ignore'
  switch (key) {
    case 'ArrowRight':
      return shift ? step_second(timeline, index, 1) : step_event(index, 1, timeline.count)
    case 'ArrowLeft':
      return shift ? step_second(timeline, index, -1) : step_event(index, -1, timeline.count)
    case 'Home':
      return 0
    case 'End':
      return 'live'
    default:
      return 'ignore'
  }
}

/**
 * The session at an event index: fold `frames[0..=index]` from empty, the same
 * `apply_frame` the live tail applies per event. This is the whole of replay
 * (C5); the property test holds it equal to the state incremental application
 * reached, so live mode is only this fold pinned to the newest event.
 */
export function session_at(frames: ReadonlyArray<ViewerFrame>, index: number): Session {
  let session = EMPTY_SESSION
  const upto = clamp(index + 1, 0, frames.length)
  for (let i = 0; i < upto; i += 1) session = apply_frame(session, frames[i])
  return session
}

/** The event whose time is closest to a target, over a clock that only rises. */
function nearest_index(times: ReadonlyArray<number>, target: number): number {
  let after = times.length
  for (let i = 0; i < times.length; i += 1) {
    if ((times[i] ?? 0) >= target) {
      after = i
      break
    }
  }
  if (after <= 0) return 0
  if (after >= times.length) return times.length - 1
  const before = after - 1
  return target - (times[before] ?? 0) <= (times[after] ?? 0) - target ? before : after
}

/** An elapsed offset as a spine fraction, zero when the run has no span yet. */
function spine_fraction(elapsed: number, span_ms: number): number {
  return span_ms > 0 ? clamp(elapsed / span_ms, 0, 1) : 0
}

/** Read a finite `ts` off a wire frame, null when absent or unusable. */
function read_ts(frame: ViewerFrame): number | null {
  const ts = frame['ts']
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : null
}

/** Hold a value inside an inclusive range. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}
