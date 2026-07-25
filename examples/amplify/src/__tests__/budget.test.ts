import { describe, expect, it } from 'vitest'

import {
  budget_exhausted,
  budget_plateau,
  initial_budget,
  note_no_progress,
  note_progress,
  open_round,
  stop_reason,
} from '../budget.js'

const T0 = 1_000_000

describe('budget', () => {
  it('exhausts after max_rounds', () => {
    let b = initial_budget({ max_rounds: 3, max_wallclock_ms: 1_000_000, patience: 99 }, T0)
    expect(budget_exhausted(b, T0)).toBe(false)
    b = open_round(open_round(b))
    expect(budget_exhausted(b, T0)).toBe(false)
    b = open_round(b)
    expect(budget_exhausted(b, T0)).toBe(true)
  })

  it('exhausts once the wall-clock budget elapses', () => {
    const b = open_round(
      initial_budget({ max_rounds: 99, max_wallclock_ms: 500, patience: 99 }, T0),
    )
    expect(budget_exhausted(b, T0 + 499)).toBe(false)
    expect(budget_exhausted(b, T0 + 500)).toBe(true)
  })

  it('plateaus after `patience` no-progress notes', () => {
    let b = initial_budget({ max_rounds: 99, max_wallclock_ms: 1_000_000, patience: 2 }, T0)
    expect(budget_plateau(b)).toBe(false)
    b = note_no_progress(b)
    expect(budget_plateau(b)).toBe(false)
    b = note_no_progress(b)
    expect(budget_plateau(b)).toBe(true)
  })

  it('resets the plateau counter on progress', () => {
    let b = initial_budget({ max_rounds: 99, max_wallclock_ms: 1_000_000, patience: 2 }, T0)
    b = note_no_progress(b)
    b = note_progress(b)
    b = note_no_progress(b)
    expect(budget_plateau(b)).toBe(false)
  })

  it('never mutates the state it is given', () => {
    const b = initial_budget({ max_rounds: 5, max_wallclock_ms: 500, patience: 1 }, T0)
    open_round(b)
    note_no_progress(b)
    expect(b.rounds_used).toBe(0)
    expect(b.rounds_since_progress).toBe(0)
  })

  it('names which rule stopped the loop, preferring plateau', () => {
    const config = { max_rounds: 1, max_wallclock_ms: 500, patience: 1 }
    expect(stop_reason(initial_budget(config, T0), T0)).toBeUndefined()
    expect(stop_reason(open_round(initial_budget(config, T0)), T0)).toBe('max_rounds')
    expect(stop_reason(initial_budget(config, T0), T0 + 500)).toBe('budget')
    expect(stop_reason(note_no_progress(initial_budget(config, T0)), T0)).toBe('plateau')
  })

  it('carries the config through for logging', () => {
    const b = open_round(initial_budget({ max_rounds: 5, max_wallclock_ms: 500, patience: 1 }, T0))
    expect(b.rounds_used).toBe(1)
    expect(b.max_rounds).toBe(5)
    expect(b.patience).toBe(1)
  })
})
