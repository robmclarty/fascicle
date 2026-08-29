import { createMemo, createSignal, type Setter } from 'solid-js'
import { render } from 'solid-js/web'
import { Canvas } from './canvas'
import { CURSOR_HEADER, events_url, fold_history, read_cursor_header } from './history'
import {
  build_timeline,
  fraction_at,
  index_at_fraction,
  scrub_key,
  session_at,
  type Timeline,
} from './lib/timeline'
import { EMPTY_SESSION, apply_frame, type Session } from './lib/scene'
import { connect_events, type SseStatus, type ViewerFrame } from './sse'
import type { Viewport } from './stage'
import './styles.css'

/*
 * The app entry: own the signals, load the run, mount the canvas.
 *
 * This is the only module that touches a browser global. Everything it wires
 * together is injectable, so the fold, history, and timeline logic is covered
 * by node unit tests and this file is covered by the Playwright suite loading
 * the built app.
 *
 * The session and its arrival stamp travel in one signal because they are
 * one fact: the header's live clock counts from the moment the newest frame
 * landed, and a stamp that could lag its session by a frame would make the
 * displayed T+ jump. The animation-frame loop only samples the clock; state
 * stays the pure fold (C5).
 *
 * Replay rides the same fold. The frame log keeps every event in order, and a
 * held scrub index selects a prefix the app refolds with `session_at`; live
 * mode is that fold pinned to the newest event, which is what a null held index
 * means (follow the edge). The header, the canvas, and the scrubber all read
 * the one selected session, so amber never lives in two timelines at once (Q2).
 */

type Feed = {
  readonly session: Session
  readonly received_at_ms: number | null
}

/** Mounts the canvas into `#root`, folds the history, then follows the tail. */
function main(): void {
  const root = document.querySelector('#root')
  if (root === null) throw new Error('viewer app: #root is missing from index.html')

  const [frames, set_frames] = createSignal<ReadonlyArray<ViewerFrame>>([])
  const [feed, set_feed] = createSignal<Feed>({
    session: EMPTY_SESSION,
    received_at_ms: null,
  })
  const [status, set_status] = createSignal<SseStatus>('connecting')
  const [now_ms, set_now_ms] = createSignal(performance.now())
  const [viewport, set_viewport] = createSignal(current_viewport())
  // A null held index follows the live edge; a number holds a past prefix.
  const [held, set_held] = createSignal<number | null>(null)
  window.addEventListener('resize', () => set_viewport(current_viewport()))

  const timeline = createMemo(() => build_timeline(frames()))
  const following = createMemo(() => held() === null)
  const index = createMemo(() => held() ?? Math.max(0, timeline().count - 1))
  const session = createMemo(() =>
    held() === null ? feed().session : session_at(frames(), index()),
  )
  const received_at_ms = createMemo(() => (held() === null ? feed().received_at_ms : null))

  const seek = (fraction: number): void => {
    set_held(index_at_fraction(timeline(), fraction))
  }
  const return_to_live = (): void => {
    set_held(null)
  }
  window.addEventListener('keydown', (event) => on_key(event, timeline(), index(), set_held))

  const tick = (frame_ts: number): void => {
    set_now_ms(frame_ts)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  render(
    () => (
      <Canvas
        session={session()}
        status={status()}
        viewport={viewport()}
        received_at_ms={received_at_ms()}
        now_ms={now_ms()}
        following={following()}
        timeline={timeline()}
        fraction={fraction_at(timeline(), index())}
        on_seek={seek}
        on_return_to_live={return_to_live}
      />
    ),
    root,
  )

  void follow_run(set_frames, set_feed, set_status)
}

/**
 * Route a keydown to the scrub move `scrub_key` decides (Q5), forwarding it to
 * the held index: `'live'` re-attaches to the edge, a number holds that prefix,
 * `'ignore'` leaves the page's own key handling alone. The default is prevented
 * only for a key the scrubber actually took.
 */
function on_key(
  event: KeyboardEvent,
  timeline: Timeline,
  index: number,
  set_held: Setter<number | null>,
): void {
  const move = scrub_key(timeline, index, event.key, event.shiftKey)
  if (move === 'ignore') return
  set_held(move === 'live' ? null : move)
  event.preventDefault()
}

/**
 * Fold the full run history, then follow the live tail from its edge (D7).
 *
 * History arrives once over `/api/trajectory` (the whole file, or the ring when
 * the server is ingest-fed), so a finished `.jsonl` opened with no live producer
 * renders complete from the first paint. The frame log is seeded from the same
 * frames history folded, and each SSE frame appends to it, so a scrub of either
 * a loaded or a live run refolds the exact events that produced the canvas. SSE
 * resumes past the history cursor, which is what keeps the fold from
 * double-counting the events both transports would otherwise carry. A transport
 * error just starts empty and lets SSE carry the run from here: a localhost dev
 * tool has nothing to retry against.
 */
async function follow_run(
  set_frames: Setter<ReadonlyArray<ViewerFrame>>,
  set_feed: Setter<Feed>,
  set_status: Setter<SseStatus>,
): Promise<void> {
  let cursor = 0
  try {
    const res = await fetch('/api/trajectory')
    const history = fold_history(await res.text(), read_cursor_header(res.headers.get(CURSOR_HEADER)))
    cursor = history.cursor
    if (history.count > 0) {
      set_frames(history.frames)
      set_feed({ session: history.session, received_at_ms: performance.now() })
    }
  } catch {
    // No history folded; SSE carries the run from the plain stream.
  }

  connect_events({
    url: events_url(cursor),
    open: (url) => new EventSource(url),
    on_status: set_status,
    on_frame: (frame) => {
      set_frames((prev) => [...prev, frame])
      set_feed(({ session }) => ({
        session: apply_frame(session, frame),
        received_at_ms: performance.now(),
      }))
    },
  })
}

/** The window's inner size, the box the stage fits the flow into. */
function current_viewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight }
}

main()
