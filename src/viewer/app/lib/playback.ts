/**
 * Play mode: the clock that performs the run.
 *
 * Replay is a pure fold and the scrubber is its coordinate; play mode adds no
 * third idea. It is a schedule mapping each event's run-time offset to the
 * wall-clock moment playback should reach it, and a position lookup the app
 * samples once per animation frame to choose which prefix to refold. The fold
 * never reads this clock (C5): playback only moves the held index a scrub
 * would move, so the canvas cannot tell a performance from a live run and the
 * easing (marquee, halo, state transitions) is identical by construction.
 *
 * The schedule is the real ts deltas divided by the speed multiplier, with an
 * optional cap on the wall-clock cost of any single inter-event gap. The cap
 * is what makes a long run watchable: a model call's dead air collapses to
 * the cap while dense bursts keep their real pacing, which is how a
 * ten-minute run plays in a minute or two. Inside a capped gap the
 * interpolated T+ advances faster than the speed alone would move it, the
 * header's honest signal that time is being compressed.
 *
 * Transitions re-anchor rather than accumulate: the anchor is an event index
 * plus the wall moment playback (re)started there, so a speed change, a
 * compression toggle, or a mid-play scrub all continue from the playhead
 * without replaying or skipping wall time. Pausing keeps the held prefix and
 * drops the intra-gap remainder on purpose, the same snap-to-event a scrub
 * settles with. Event times are the timeline's fold clock, non-decreasing by
 * construction, and that precondition is assumed rather than re-checked.
 */

export type PlaySpeed = 1 | 2 | 3

/** The spec's order-2s cap: the most wall-clock any inter-event gap may cost. */
export const GAP_CAP_MS = 2000

/** Cursor-idle delay before playing chrome fades for a clean recording. */
export const CHROME_IDLE_MS = 2500

/**
 * The performance schedule: `wall_times[i]` is the wall-clock offset at which
 * playback reaches event `i`, and `wall_total_ms` is the whole performance's
 * length (the last event's offset).
 */
export type PlaybackPlan = {
  readonly wall_times: ReadonlyArray<number>
  readonly wall_total_ms: number
}

/**
 * Schedule the run's event times onto the wall clock: each gap plays at its
 * real length divided by the speed, and a non-null cap bounds what any single
 * gap may cost after that division, so compression collapses dead air without
 * touching the pacing of dense bursts.
 */
export function build_plan(
  times: ReadonlyArray<number>,
  speed: PlaySpeed,
  gap_cap_ms: number | null,
): PlaybackPlan {
  const wall_times: number[] = []
  let wall = 0
  let prev: number | null = null
  for (const time of times) {
    if (prev !== null) {
      const gap = (time - prev) / speed
      wall += gap_cap_ms === null ? gap : Math.min(gap, gap_cap_ms)
    }
    wall_times.push(wall)
    prev = time
  }
  return { wall_times, wall_total_ms: wall }
}

/** The schedule a playback state asks for, compression turned into the cap. */
export function plan_for(times: ReadonlyArray<number>, playback: Playback): PlaybackPlan {
  return build_plan(times, playback.speed, playback.compress ? GAP_CAP_MS : null)
}

/**
 * Where the performance stands: the last event the wall clock has reached
 * (the prefix to refold), the interpolated run-time T+ the header should show
 * inside the current gap, and whether the schedule is spent.
 */
export type PlayheadPosition = {
  readonly index: number
  readonly t_plus_ms: number
  readonly done: boolean
}

/**
 * Look a wall-clock offset up in the schedule. The index is the last event at
 * or behind the offset, so simultaneous events fire together; the T+ between
 * two events interpolates the real gap over its scheduled wall length, which
 * is exactly where a compressed gap makes the header visibly accelerate.
 */
export function position_at(
  plan: PlaybackPlan,
  times: ReadonlyArray<number>,
  wall_elapsed_ms: number,
): PlayheadPosition {
  const { wall_times, wall_total_ms } = plan
  const count = wall_times.length
  if (count === 0) return { index: 0, t_plus_ms: 0, done: true }
  const elapsed = Math.max(0, wall_elapsed_ms)
  if (elapsed >= wall_total_ms) {
    return { index: count - 1, t_plus_ms: times[count - 1] ?? 0, done: true }
  }
  let index = 0
  for (let i = 1; i < count; i += 1) {
    if ((wall_times[i] ?? 0) > elapsed) break
    index = i
  }
  const wall_here = wall_times[index] ?? 0
  const wall_next = wall_times[index + 1] ?? wall_total_ms
  const here = times[index] ?? 0
  const next = times[index + 1] ?? here
  const fraction = (elapsed - wall_here) / (wall_next - wall_here)
  return { index, t_plus_ms: here + fraction * (next - here), done: false }
}

/**
 * The playback state the app holds: whether the clock is running, the dials
 * (speed, compression, loop), and the anchor the running clock counts from.
 * The anchor fields are meaningless while paused.
 */
export type Playback = {
  readonly playing: boolean
  readonly speed: PlaySpeed
  readonly compress: boolean
  readonly loop: boolean
  readonly anchor_index: number
  readonly anchor_now_ms: number
}

/** At rest: paused at 1x, compression on (the watchable default), no loop. */
export const INITIAL_PLAYBACK: Playback = {
  playing: false,
  speed: 1,
  compress: true,
  loop: false,
  anchor_index: 0,
  anchor_now_ms: 0,
}

/**
 * Space and the PLAY control: pause in place, or perform from the playhead.
 * A playhead at the run's end, or following the live edge (`null`, the same
 * place), restarts the performance at T+0; a run under two events has no gap
 * to perform and stays paused.
 */
export function toggle_play(
  playback: Playback,
  index: number | null,
  count: number,
  now_ms: number,
): Playback {
  if (playback.playing) return { ...playback, playing: false }
  if (count < 2) return playback
  const at_end = index === null || index >= count - 1
  return {
    ...playback,
    playing: true,
    anchor_index: at_end ? 0 : index,
    anchor_now_ms: now_ms,
  }
}

/** The speed dial: 1x, 2x, 3x, around; a running clock continues from here. */
export function cycle_speed(playback: Playback, index: number, now_ms: number): Playback {
  const speed: PlaySpeed = playback.speed === 1 ? 2 : playback.speed === 2 ? 3 : 1
  return anchored({ ...playback, speed }, index, now_ms)
}

/** Flip gap compression; a running clock continues from the playhead. */
export function toggle_compress(playback: Playback, index: number, now_ms: number): Playback {
  return anchored({ ...playback, compress: !playback.compress }, index, now_ms)
}

/** Flip the loop dial; it is only consulted when the schedule runs out. */
export function toggle_loop(playback: Playback): Playback {
  return { ...playback, loop: !playback.loop }
}

/** A manual scrub during playback: the performance continues from there. */
export function hold_at(playback: Playback, index: number, now_ms: number): Playback {
  return anchored(playback, index, now_ms)
}

/** Leave play mode without moving the playhead (return-to-live does this). */
export function stop_playback(playback: Playback): Playback {
  return playback.playing ? { ...playback, playing: false } : playback
}

/** The wall offset of the running clock right now, under the current plan. */
export function play_elapsed_ms(plan: PlaybackPlan, playback: Playback, now_ms: number): number {
  return (plan.wall_times[playback.anchor_index] ?? 0) + (now_ms - playback.anchor_now_ms)
}

/**
 * Recording polish: the interaction chrome fades once a performance has run
 * with the cursor idle, so a screen capture shows only the canvas. Paused, or
 * touched recently, the chrome stays.
 */
export function chrome_hidden(
  playback: Playback,
  last_activity_ms: number,
  now_ms: number,
): boolean {
  return playback.playing && now_ms - last_activity_ms >= CHROME_IDLE_MS
}

/** Re-anchor a running clock at an index so wall time neither replays nor skips. */
function anchored(playback: Playback, index: number, now_ms: number): Playback {
  return playback.playing
    ? { ...playback, anchor_index: index, anchor_now_ms: now_ms }
    : playback
}
