/**
 * The header's live clock: the one place the displayed T+ leaves the fold.
 *
 * The contract under test is artboard 01's `T+130MS`, a moment that sits
 * between events: the clock advances by real time since the newest frame
 * while the run is live, and snaps back to the fold's truth the moment the
 * run ends, the stream drops, or nothing has arrived to count from.
 */

import { describe, expect, it } from 'vitest'
import { live_t_plus_ms } from '../app/lib/clock.js'

const base = {
  fold_t_plus_ms: 113,
  run_over: false,
  connected: true,
  received_at_ms: 1000,
  now_ms: 1017,
}

describe('live_t_plus_ms', () => {
  it('advances the fold clock by the time since the newest frame', () => {
    expect(live_t_plus_ms(base)).toBe(130)
    expect(live_t_plus_ms({ ...base, now_ms: 1000 })).toBe(113)
  })

  it('freezes at the fold once the run has ended', () => {
    expect(live_t_plus_ms({ ...base, run_over: true })).toBe(113)
  })

  it('freezes at the fold when the stream is not live', () => {
    expect(live_t_plus_ms({ ...base, connected: false })).toBe(113)
  })

  it('freezes at the fold before any frame has arrived', () => {
    expect(live_t_plus_ms({ ...base, received_at_ms: null, fold_t_plus_ms: 0 })).toBe(0)
  })

  it('never counts backward when the now-stamp lags the arrival stamp', () => {
    expect(live_t_plus_ms({ ...base, now_ms: 990 })).toBe(113)
  })
})
