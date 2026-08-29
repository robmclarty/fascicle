/**
 * The header's live clock: which T+ the header names between events.
 *
 * Canvas state is a pure fold with no wall-clock reads (C5), so the fold's
 * elapsed time freezes at the newest event. A live run spends most of its
 * life between events (a model call is one long silence), and artboard 01's
 * `T+130MS` sits inside exactly such a gap, 17ms after the last span
 * closed: the design requires the header to keep counting while the run is
 * alive. This module is that one concession, kept out of the fold: the
 * displayed T+ is the fold's clock plus the real time since the newest
 * event arrived. State never reads a clock; the header's caption does.
 *
 * The clock freezes back to the fold the moment the run has ended (the
 * final T+ is the run's true duration) or the stream is not live (a dead
 * feed must not count silence as progress). The clamp guards a now-stamp
 * taken before the frame's arrival stamp, which a paused or mocked clock
 * can produce.
 */

export type LiveClockInput = {
  /** The fold's elapsed time: newest event ts minus first event ts. */
  readonly fold_t_plus_ms: number
  /** True once `run_end` resolved the run; the clock freezes on truth. */
  readonly run_over: boolean
  /** True while the SSE stream is live; silence on a dead feed is not time. */
  readonly connected: boolean
  /** When the newest frame arrived, on the same clock as `now_ms`. */
  readonly received_at_ms: number | null
  /** The renderer's current monotonic time. */
  readonly now_ms: number
}

/** The T+ the header shows right now. */
export function live_t_plus_ms(input: LiveClockInput): number {
  const { fold_t_plus_ms, run_over, connected, received_at_ms, now_ms } = input
  if (run_over || !connected || received_at_ms === null) return fold_t_plus_ms
  return fold_t_plus_ms + Math.max(0, now_ms - received_at_ms)
}
