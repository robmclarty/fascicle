import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { Canvas } from './canvas'
import { EMPTY_SESSION, apply_frame } from './lib/scene'
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
 */

/** Mounts the canvas into `#root` and feeds it the live SSE stream. */
function main(): void {
  const root = document.querySelector('#root')
  if (root === null) throw new Error('viewer app: #root is missing from index.html')

  const [session, set_session] = createSignal(EMPTY_SESSION)
  const [status, set_status] = createSignal<SseStatus>('connecting')
  const [viewport, set_viewport] = createSignal(current_viewport())
  window.addEventListener('resize', () => set_viewport(current_viewport()))

  connect_events({
    url: '/api/events',
    open: (url) => new EventSource(url),
    on_status: set_status,
    on_frame: (frame) => set_session((current) => apply_frame(current, frame)),
  })

  render(
    () => <Canvas session={session()} status={status()} viewport={viewport()} />,
    root,
  )
}

/** The window's inner size, the box the stage fits the flow into. */
function current_viewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight }
}

main()
