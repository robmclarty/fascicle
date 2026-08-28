import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { Canvas } from './canvas'
import { connect_events, type SseStatus } from './sse'
import './styles.css'

/*
 * The app entry: own the signals, open the stream, mount the canvas.
 *
 * This is the only module that touches a browser global. Everything it wires
 * together is injectable, so the stream logic is covered by node unit tests
 * and this file is covered by the Playwright suite loading the built app.
 */

/** Mounts the canvas into `#root` and feeds it the live SSE stream. */
function main(): void {
  const root = document.querySelector('#root')
  if (root === null) throw new Error('viewer app: #root is missing from index.html')

  const [run_id, set_run_id] = createSignal<string | null>(null)
  const [status, set_status] = createSignal<SseStatus>('connecting')
  const [event_count, set_event_count] = createSignal(0)

  connect_events({
    url: '/api/events',
    open: (url) => new EventSource(url),
    on_status: set_status,
    on_frame: (frame) => {
      set_event_count((n) => n + 1)
      // The header names one run (Q7), so a file holding several settles on
      // the newest. A run switcher is a later step.
      if (frame.run_id !== undefined) set_run_id(frame.run_id)
    },
  })

  render(() => <Canvas run_id={run_id()} status={status()} event_count={event_count()} />, root)
}

main()
