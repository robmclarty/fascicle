import { describe, expect, it } from 'vitest'

import { make_budget } from './budget.js'

describe('budget', () => {
  it('exhausts after max_rounds', () => {
    const b = make_budget({ max_rounds: 3, max_wallclock_ms: 1_000_000, patience: 99 })
    expect(b.exhausted()).toBe(false)
    b.next_round()
    b.next_round()
    expect(b.exhausted()).toBe(false)
    b.next_round()
    expect(b.exhausted()).toBe(true)
  })

  it('plateaus after `patience` no-progress notes', () => {
    const b = make_budget({ max_rounds: 99, max_wallclock_ms: 1_000_000, patience: 2 })
    expect(b.plateau()).toBe(false)
    b.note_no_progress()
    expect(b.plateau()).toBe(false)
    b.note_no_progress()
    expect(b.plateau()).toBe(true)
  })

  it('resets the plateau counter on progress', () => {
    const b = make_budget({ max_rounds: 99, max_wallclock_ms: 1_000_000, patience: 2 })
    b.note_no_progress()
    b.note_progress()
    b.note_no_progress()
    expect(b.plateau()).toBe(false)
  })

  it('exposes cumulative state for logging', () => {
    const b = make_budget({ max_rounds: 5, max_wallclock_ms: 500, patience: 1 })
    b.next_round()
    b.note_no_progress()
    const s = b.state()
    expect(s.rounds_used).toBe(1)
    expect(s.rounds_since_progress).toBe(1)
    expect(s.max_rounds).toBe(5)
    expect(s.patience).toBe(1)
  })
})
