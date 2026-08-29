import { createSignal, type Setter } from 'solid-js'
import { render } from 'solid-js/web'
import { Canvas } from './canvas'
import { CURSOR_HEADER, events_url, fold_history, read_cursor_header } from './history'
import { EMPTY_SESSION, apply_frame, type Session } from './lib/scene'
import { connect_events, type SseStatus } from './sse'
import type { Viewport } from './stage'
import './styles.css'

/*
 * The app entry: own the signals, load the run, mount the canvas.
 *
 * This is the only module that touches a browser global. Everything it wires
 * together is injectable, so the fold and history logic is covered by node
 * unit tests and this file is covered by the Playwright suite loading the
 * built app.
 *
 * The session and its arrival stamp travel in one signal because they are
 * one fact: the header's live clock counts from the moment the newest frame
 * landed, and a stamp that could lag its session by a frame would make the
 * displayed T+ jump. The animation-frame loop only samples the clock; state
 * stays the pure fold (C5).
 */

type Feed = {
  readonly session: Session
  readonly received_at_ms: number | null
}

/** Mounts the canvas into `#root`, folds the history, then follows the tail. */
function main(): void {
  const root = document.querySelector('#root')
  if (root === null) throw new Error('viewer app: #root is missing from index.html')

  const [feed, set_feed] = createSignal<Feed>({
    session: EMPTY_SESSION,
    received_at_ms: null,
  })
  const [status, set_status] = createSignal<SseStatus>('connecting')
  const [now_ms, set_now_ms] = createSignal(performance.now())
  const [viewport, set_viewport] = createSignal(current_viewport())
  window.addEventListener('resize', () => set_viewport(current_viewport()))

  const tick = (frame_ts: number): void => {
    set_now_ms(frame_ts)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  render(
    () => (
      <Canvas
        session={feed().session}
        status={status()}
        viewport={viewport()}
        received_at_ms={feed().received_at_ms}
        now_ms={now_ms()}
      />
    ),
    root,
  )

  void follow_run(set_feed, set_status)
}

/**
 * Fold the full run history, then follow the live tail from its edge (D7).
 *
 * History arrives once over `/api/trajectory` (the whole file, or the ring when
 * the server is ingest-fed), so a finished `.jsonl` opened with no live producer
 * renders complete from the first paint. SSE then resumes past the history
 * cursor, which is what keeps the fold from double-counting the events both
 * transports would otherwise carry. A transport error just starts empty and
 * lets SSE carry the run from here: a localhost dev tool has nothing to retry
 * against.
 */
async function follow_run(
  set_feed: Setter<Feed>,
  set_status: Setter<SseStatus>,
): Promise<void> {
  let cursor = 0
  try {
    const res = await fetch('/api/trajectory')
    const history = fold_history(await res.text(), read_cursor_header(res.headers.get(CURSOR_HEADER)))
    cursor = history.cursor
    if (history.count > 0) {
      set_feed({ session: history.session, received_at_ms: performance.now() })
    }
  } catch {
    // No history folded; SSE carries the run from the plain stream.
  }

  connect_events({
    url: events_url(cursor),
    open: (url) => new EventSource(url),
    on_status: set_status,
    on_frame: (frame) =>
      set_feed(({ session }) => ({
        session: apply_frame(session, frame),
        received_at_ms: performance.now(),
      })),
  })
}

/** The window's inner size, the box the stage fits the flow into. */
function current_viewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight }
}

main()
