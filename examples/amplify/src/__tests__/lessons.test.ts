import { describe, expect, it } from 'vitest'

import { append_lessons, format_lessons } from '../lessons.js'
import type { Lesson } from '../types.js'

function lesson(round: number, proposer_id: string, summary: string): Lesson {
  return { round, proposer_id, stage_failed: 'gate', summary }
}

describe('lessons', () => {
  it('caps at capacity, dropping the oldest', () => {
    const buffer = append_lessons(
      [],
      [lesson(1, 'a', 'first'), lesson(2, 'b', 'second'), lesson(3, 'c', 'third')],
      2,
    )
    expect(buffer).toHaveLength(2)
    expect(buffer[0]?.summary).toBe('second')
    expect(buffer[1]?.summary).toBe('third')
  })

  it('caps across successive appends, not just within one', () => {
    let buffer = append_lessons([], [lesson(1, 'a', 'first')], 2)
    buffer = append_lessons(buffer, [lesson(2, 'b', 'second')], 2)
    buffer = append_lessons(buffer, [lesson(3, 'c', 'third')], 2)
    expect(buffer.map((l) => l.summary)).toEqual(['second', 'third'])
  })

  it('never mutates the buffer it is given', () => {
    const original = [lesson(1, 'a', 'first')]
    append_lessons(original, [lesson(2, 'b', 'second')], 2)
    expect(original).toHaveLength(1)
  })

  it('formats an empty buffer as the empty string', () => {
    expect(format_lessons([])).toBe('')
  })

  it('formats lessons as a bullet list', () => {
    const text = format_lessons([lesson(1, 'a', 'broke tests')])
    expect(text).toContain('Lessons from prior failed attempts')
    expect(text).toContain('round 1')
    expect(text).toContain('broke tests')
  })

  it('rejects non-positive capacity', () => {
    expect(() => append_lessons([], [lesson(1, 'a', 'x')], 0)).toThrow()
  })
})
