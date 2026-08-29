import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { Canvas } from './canvas'
import { EMPTY_SESSION, apply_frame, type Session } from './lib/scene'
import { connect_events, type SseStatus } from './sse'
import type { Viewport } from './stage'
import './styles.css'

/*
 * The app entry: own the signals, open the stream, mount the canvas.
 *
 * This is the only module that touches a browser global. Everything it wires
 * together is injectable, so the stream and fold logic is covered by node
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

/** Mounts the canvas into `#root` and feeds it the live SSE stream. */
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

  connect_events({
    url: '/api/events',
    open: (url) => new EventSource(url),
    on_status: set_status,
    on_frame: (frame) =>
      set_feed(({ session }) => ({
        session: apply_frame(session, frame),
        received_at_ms: performance.now(),
      })),
  })

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
}

/** The window's inner size, the box the stage fits the flow into. */
function current_viewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight }
}

main()
