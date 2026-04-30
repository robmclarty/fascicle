import { describe, expect, it } from 'vitest'

import { make_lessons } from './lessons.js'

describe('lessons', () => {
  it('caps at capacity, dropping the oldest', () => {
    const l = make_lessons(2)
    l.append({ round: 1, proposer_id: 'a', stage_failed: 'gate', summary: 'first' })
    l.append({ round: 2, proposer_id: 'b', stage_failed: 'gate', summary: 'second' })
    l.append({ round: 3, proposer_id: 'c', stage_failed: 'gate', summary: 'third' })
    expect(l.size()).toBe(2)
    const list = l.list()
    expect(list[0]?.summary).toBe('second')
    expect(list[1]?.summary).toBe('third')
  })

  it('formats an empty buffer as the empty string', () => {
    expect(make_lessons(3).format()).toBe('')
  })

  it('formats lessons as a bullet list', () => {
    const l = make_lessons(3)
    l.append({ round: 1, proposer_id: 'a', stage_failed: 'gate', summary: 'broke tests' })
    const text = l.format()
    expect(text).toContain('Lessons from prior failed attempts')
    expect(text).toContain('round 1')
    expect(text).toContain('broke tests')
  })

  it('rejects non-positive capacity', () => {
    expect(() => make_lessons(0)).toThrow()
  })
})
