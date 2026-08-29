/**
 * Play mode's clock: the schedule that performs the run, and the transitions
 * that steer it.
 *
 * The design fixture pins the base claim: at 1x with no cap the schedule IS
 * the run's real ts deltas, and each multiplier divides them. Synthetic
 * domains pin what the fixture's 196ms span cannot exercise: the order-2s gap
 * cap collapsing dead air (the ten-minute run that must play in a minute or
 * two), the interpolated T+ accelerating inside a compressed gap while an
 * uncompressed gap advances at exactly the chosen speed, simultaneous events
 * firing together, and the run's ends. The transition suite holds the anchor
 * discipline: every dial change while playing re-anchors at the playhead so
 * wall time neither replays nor skips, and nothing moves while paused.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CHROME_IDLE_MS,
  GAP_CAP_MS,
  INITIAL_PLAYBACK,
  build_plan,
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
} from '../app/lib/playback.js'
import { build_timeline } from '../app/lib/timeline.js'
import type { ViewerFrame } from '../app/sse.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const frames = readFileSync(join(HERE, 'fixtures', 'fixture.trajectory.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as ViewerFrame)

/** The fixture's fold clock: 42 events over a 196ms span. */
const FIXTURE_TIMES = build_timeline(frames).times

/** A run with one dense burst and one 20s silence, for the cap semantics. */
const GAPPY = [0, 1000, 21_000, 21_500]

/** A playing state anchored at an index, for the transition suite. */
const PLAYING: Playback = {
  playing: true,
  speed: 1,
  compress: true,
  loop: false,
  anchor_index: 3,
  anchor_now_ms: 500,
}

describe('build_plan on the fixture (real ts deltas)', () => {
  it('is the run itself at 1x with no cap', () => {
    expect(build_plan(FIXTURE_TIMES, 1, null).wall_times).toEqual(FIXTURE_TIMES)
  })

  it.each([2, 3] as const)('divides every delta at %dx', (speed) => {
    const plan = build_plan(FIXTURE_TIMES, speed, null)
    for (const [i, time] of FIXTURE_TIMES.entries()) {
      expect(plan.wall_times[i]).toBeCloseTo(time / speed, 6)
    }
    expect(plan.wall_total_ms).toBeCloseTo(196 / speed, 6)
  })

  it('the fixture has no gap for the default cap to touch', () => {
    expect(build_plan(FIXTURE_TIMES, 1, GAP_CAP_MS).wall_times).toEqual(FIXTURE_TIMES)
  })

  it('schedules gaps, not absolute offsets, when the clock starts late', () => {
    expect(build_plan([500, 1500], 2, null).wall_times).toEqual([0, 500])
  })
})

describe('build_plan gap compression', () => {
  it('caps each gap after the speed division, leaving short gaps real', () => {
    expect(build_plan(GAPPY, 1, GAP_CAP_MS).wall_times).toEqual([0, 1000, 3000, 3500])
    expect(build_plan(GAPPY, 2, GAP_CAP_MS).wall_times).toEqual([0, 500, 2500, 2750])
  })

  it('plays a ten-minute run in about a minute at 2x with the cap', () => {
    const times = Array.from({ length: 31 }, (_, i) => i * 20_000)
    const plan = build_plan(times, 2, GAP_CAP_MS)
    expect(times.at(-1)).toBe(600_000)
    expect(plan.wall_total_ms).toBeGreaterThanOrEqual(60_000)
    expect(plan.wall_total_ms).toBeLessThanOrEqual(120_000)
  })

  it('plan_for reads the cap off the compress dial', () => {
    expect(plan_for(GAPPY, { ...INITIAL_PLAYBACK, compress: true })).toEqual(
      build_plan(GAPPY, 1, GAP_CAP_MS),
    )
    expect(plan_for(GAPPY, { ...INITIAL_PLAYBACK, compress: false })).toEqual(
      build_plan(GAPPY, 1, null),
    )
  })
})

describe('position_at', () => {
  const plan = build_plan(GAPPY, 1, GAP_CAP_MS)

  it('lands each scheduled moment exactly on its event', () => {
    for (const [i, wall] of plan.wall_times.entries()) {
      const position = position_at(plan, GAPPY, wall)
      expect(position.index).toBe(i)
      expect(position.t_plus_ms).toBe(GAPPY[i])
    }
  })

  it('advances T+ at the chosen speed through an uncompressed gap', () => {
    expect(position_at(plan, GAPPY, 500).t_plus_ms).toBe(500)
  })

  it('accelerates T+ through a compressed gap (the honest fast-forward)', () => {
    // Halfway through the capped 2s of wall is halfway through 20s of run.
    const position = position_at(plan, GAPPY, 2000)
    expect(position.index).toBe(1)
    expect(position.t_plus_ms).toBe(11_000)
  })

  it('is done at and past the schedule end, seated on the last event', () => {
    expect(position_at(plan, GAPPY, plan.wall_total_ms)).toEqual({
      index: 3,
      t_plus_ms: 21_500,
      done: true,
    })
    expect(position_at(plan, GAPPY, 999_999).done).toBe(true)
  })

  it('clamps a pre-start offset to the first event', () => {
    expect(position_at(plan, GAPPY, -50)).toEqual({ index: 0, t_plus_ms: 0, done: false })
  })

  it('fires simultaneous events together', () => {
    const burst = [0, 0, 0, 100]
    const burst_plan = build_plan(burst, 1, null)
    expect(position_at(burst_plan, burst, 0)).toEqual({ index: 2, t_plus_ms: 0, done: false })
  })

  it('is spent immediately on an empty schedule', () => {
    expect(position_at(build_plan([], 1, null), [], 0)).toEqual({
      index: 0,
      t_plus_ms: 0,
      done: true,
    })
  })
})

describe('toggle_play', () => {
  it('performs from a held mid-run playhead', () => {
    const state = toggle_play(INITIAL_PLAYBACK, 5, 42, 1234)
    expect(state.playing).toBe(true)
    expect(state.anchor_index).toBe(5)
    expect(state.anchor_now_ms).toBe(1234)
  })

  it('restarts at T+0 from the live edge and from the run end', () => {
    expect(toggle_play(INITIAL_PLAYBACK, null, 42, 0).anchor_index).toBe(0)
    expect(toggle_play(INITIAL_PLAYBACK, 41, 42, 0).anchor_index).toBe(0)
  })

  it('pauses in place when already playing', () => {
    expect(toggle_play(PLAYING, 7, 42, 999)).toEqual({ ...PLAYING, playing: false })
  })

  it('has nothing to perform under two events, and two is enough', () => {
    expect(toggle_play(INITIAL_PLAYBACK, 0, 1, 0)).toBe(INITIAL_PLAYBACK)
    expect(toggle_play(INITIAL_PLAYBACK, null, 0, 0)).toBe(INITIAL_PLAYBACK)
    expect(toggle_play(INITIAL_PLAYBACK, 0, 2, 0).playing).toBe(true)
  })
})

describe('dial changes', () => {
  it('cycles the speed 1x -> 2x -> 3x -> 1x', () => {
    const two = cycle_speed(INITIAL_PLAYBACK, 0, 0)
    const three = cycle_speed(two, 0, 0)
    expect(two.speed).toBe(2)
    expect(three.speed).toBe(3)
    expect(cycle_speed(three, 0, 0).speed).toBe(1)
  })

  it('re-anchors a running clock at the playhead, and only then', () => {
    const running = cycle_speed(PLAYING, 9, 4000)
    expect(running).toMatchObject({ speed: 2, anchor_index: 9, anchor_now_ms: 4000 })
    const paused = cycle_speed(INITIAL_PLAYBACK, 9, 4000)
    expect(paused.anchor_index).toBe(INITIAL_PLAYBACK.anchor_index)
    expect(paused.anchor_now_ms).toBe(INITIAL_PLAYBACK.anchor_now_ms)
  })

  it('toggle_compress flips the cap and re-anchors while running', () => {
    expect(toggle_compress(PLAYING, 9, 4000)).toMatchObject({
      compress: false,
      anchor_index: 9,
      anchor_now_ms: 4000,
    })
    expect(toggle_compress(INITIAL_PLAYBACK, 9, 4000).compress).toBe(false)
  })

  it('toggle_loop flips the dial and nothing else', () => {
    expect(toggle_loop(PLAYING)).toEqual({ ...PLAYING, loop: true })
    expect(toggle_loop(toggle_loop(PLAYING))).toEqual(PLAYING)
  })
})

describe('hold_at and stop_playback', () => {
  it('a mid-play scrub continues the performance from there', () => {
    expect(hold_at(PLAYING, 11, 7000)).toEqual({
      ...PLAYING,
      anchor_index: 11,
      anchor_now_ms: 7000,
    })
  })

  it('a paused scrub leaves playback untouched', () => {
    expect(hold_at(INITIAL_PLAYBACK, 11, 7000)).toBe(INITIAL_PLAYBACK)
  })

  it('stop_playback leaves play mode and is a no-op at rest', () => {
    expect(stop_playback(PLAYING)).toEqual({ ...PLAYING, playing: false })
    expect(stop_playback(INITIAL_PLAYBACK)).toBe(INITIAL_PLAYBACK)
  })
})

describe('play_elapsed_ms', () => {
  it('counts from the anchor event scheduled offset', () => {
    const plan = build_plan(GAPPY, 1, GAP_CAP_MS)
    const state = { ...PLAYING, anchor_index: 2, anchor_now_ms: 10_000 }
    expect(play_elapsed_ms(plan, state, 10_250)).toBe(3250)
  })
})

describe('chrome_hidden', () => {
  it('fades only a running performance whose cursor has gone idle', () => {
    expect(chrome_hidden(PLAYING, 0, CHROME_IDLE_MS)).toBe(true)
    expect(chrome_hidden(PLAYING, 0, CHROME_IDLE_MS - 1)).toBe(false)
    expect(chrome_hidden({ ...PLAYING, playing: false }, 0, CHROME_IDLE_MS)).toBe(false)
  })

  it('measures idleness from the activity stamp, not the epoch', () => {
    expect(chrome_hidden(PLAYING, 10_000, 10_000)).toBe(false)
    expect(chrome_hidden(PLAYING, 10_000, 10_000 + CHROME_IDLE_MS)).toBe(true)
  })
})

describe('INITIAL_PLAYBACK', () => {
  it('rests paused at 1x with compression on and no loop', () => {
    expect(INITIAL_PLAYBACK).toEqual({
      playing: false,
      speed: 1,
      compress: true,
      loop: false,
      anchor_index: 0,
      anchor_now_ms: 0,
    })
  })
})
