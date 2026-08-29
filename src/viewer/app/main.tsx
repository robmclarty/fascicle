import { createEffect, createMemo, createSignal, type Setter } from 'solid-js'
import { render } from 'solid-js/web'
import { Canvas } from './canvas'
import { CURSOR_HEADER, events_url, fold_history, read_cursor_header } from './history'
import {
  INITIAL_PLAYBACK,
  chrome_hidden,
  cycle_speed,
  hold_at,
  plan_for,
  play_elapsed_ms,
  position_at,
  stop_playback,
  toggle_compress,
  toggle_loop,
  toggle_play,
  type Playback,
} from './lib/playback'
import {
  build_timeline,
  fraction_at,
  index_at_fraction,
  scrub_key,
  session_at,
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
 *
 * Play mode is the same held index on a clock: while playing, each animation
 * frame looks the elapsed wall time up in the schedule `lib/playback.ts`
 * built and holds the index it lands on, so a performance is a scrub the
 * clock drags. The fold stays pure; only the choice of prefix moves. The
 * interpolated play T+ rides to the header so compressed gaps visibly
 * accelerate, and pointer or key activity feeds the idle stamp the chrome
 * fade reads.
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
  const [playback, set_playback] = createSignal<Playback>(INITIAL_PLAYBACK)
  const [last_activity_ms, set_last_activity_ms] = createSignal(performance.now())
  window.addEventListener('resize', () => set_viewport(current_viewport()))

  const timeline = createMemo(() => build_timeline(frames()))
  const following = createMemo(() => held() === null)
  const index = createMemo(() => held() ?? Math.max(0, timeline().count - 1))
  const session = createMemo(() =>
    held() === null ? feed().session : session_at(frames(), index()),
  )
  const received_at_ms = createMemo(() => (held() === null ? feed().received_at_ms : null))

  const plan = createMemo(() => plan_for(timeline().times, playback()))
  const play_position = createMemo(() => {
    const state = playback()
    if (!state.playing) return null
    return position_at(plan(), timeline().times, play_elapsed_ms(plan(), state, now_ms()))
  })
  const hidden = createMemo(() => chrome_hidden(playback(), last_activity_ms(), now_ms()))

  const hold = (target: number): void => {
    set_held(target)
    set_playback((state) => hold_at(state, target, now_ms()))
  }
  const seek = (fraction: number): void => {
    hold(index_at_fraction(timeline(), fraction))
  }
  const return_to_live = (): void => {
    set_playback(stop_playback)
    set_held(null)
  }
  const toggle = (): void => {
    set_playback((state) => toggle_play(state, held(), timeline().count, now_ms()))
  }

  /*
   * Route a keydown: Space toggles play (Q5); the rest goes to the scrub move
   * `scrub_key` decides, where `'live'` re-attaches to the edge and a number
   * holds that prefix (continuing a running performance from there). The
   * default is prevented only for a key the canvas actually took, which also
   * keeps Space from re-firing a focused control.
   */
  window.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      toggle()
      event.preventDefault()
      return
    }
    const move = scrub_key(timeline(), index(), event.key, event.shiftKey)
    if (move === 'ignore') return
    if (move === 'live') return_to_live()
    else hold(move)
    event.preventDefault()
  })

  const wake = (): void => {
    set_last_activity_ms(performance.now())
  }
  window.addEventListener('pointermove', wake)
  window.addEventListener('pointerdown', wake)
  window.addEventListener('keydown', wake)

  const tick = (frame_ts: number): void => {
    set_now_ms(frame_ts)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  // The clock drags the scrub: each frame holds the index the schedule has
  // reached, and a spent schedule either laps (loop) or leaves play mode.
  createEffect(() => {
    const position = play_position()
    if (position === null) return
    set_held(position.index)
    if (!position.done) return
    set_playback((state) =>
      state.loop
        ? { ...state, anchor_index: 0, anchor_now_ms: now_ms() }
        : { ...state, playing: false },
    )
  })

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
        playback={playback()}
        play_t_plus_ms={play_position()?.t_plus_ms ?? null}
        chrome_hidden={hidden()}
        on_seek={seek}
        on_return_to_live={return_to_live}
        on_toggle_play={toggle}
        on_cycle_speed={() => set_playback((state) => cycle_speed(state, index(), now_ms()))}
        on_toggle_compress={() =>
          set_playback((state) => toggle_compress(state, index(), now_ms()))
        }
        on_toggle_loop={() => set_playback(toggle_loop)}
      />
    ),
    root,
  )

  void follow_run(set_frames, set_feed, set_status)
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
