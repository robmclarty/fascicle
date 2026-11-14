import { describe, expect, it } from 'vitest'
import { PAGE_SIZE, session_page } from '../session_list.js'
import type { AcpSessionSummary } from '../types.js'

function summary(id: string, updated_at: string, cwd = '/work'): AcpSessionSummary {
  return { id, cwd, additional_directories: [], title: id, updated_at }
}

/** `count` sessions a second apart, the last one newest, in the order a store might give them. */
function many(count: number): AcpSessionSummary[] {
  return Array.from({ length: count }, (_, index) =>
    summary(`s${index}`, new Date(Date.UTC(2026, 9, 27, 0, 0, index)).toISOString()),
  )
}

describe('session_page', () => {
  it('lists newest first, and by id where two changed at the same instant', () => {
    const at = '2026-10-27T00:00:00.000Z'
    const page = session_page([summary('b', at), summary('old', '2026-10-26T00:00:00.000Z'), summary('a', at)], undefined, undefined)
    expect(page?.sessions.map((entry) => entry.id)).toEqual(['a', 'b', 'old'])
    expect(page).not.toHaveProperty('next_cursor')
  })

  it('keeps only the sessions that started in the cwd asked for, and all of them for none or null', () => {
    const sessions = [summary('here', '2026-10-27T00:00:00.000Z', '/a'), summary('there', '2026-10-27T00:00:01.000Z', '/b')]
    expect(session_page(sessions, '/a', undefined)?.sessions.map((entry) => entry.id)).toEqual(['here'])
    expect(session_page(sessions, null, null)?.sessions).toHaveLength(2)
    expect(session_page(sessions, undefined, undefined)?.sessions).toHaveLength(2)
  })

  it('answers exactly a page with no cursor when nothing follows it', () => {
    const page = session_page(many(PAGE_SIZE), undefined, undefined)
    expect(page?.sessions).toHaveLength(PAGE_SIZE)
    expect(page).not.toHaveProperty('next_cursor')
  })

  it('pages at 50 with a cursor, and the pages together hold every session once, in order', () => {
    const sessions = many(PAGE_SIZE * 2 + 5)
    const first = session_page(sessions, undefined, undefined)
    const second = session_page(sessions, undefined, first?.next_cursor)
    const third = session_page(sessions, undefined, second?.next_cursor)
    expect(first?.sessions).toHaveLength(PAGE_SIZE)
    expect(second?.sessions).toHaveLength(PAGE_SIZE)
    expect(third?.sessions).toHaveLength(5)
    expect(third).not.toHaveProperty('next_cursor')
    const ids = [first, second, third].flatMap((page) => page?.sessions.map((entry) => entry.id) ?? [])
    expect(ids).toEqual(sessions.map((entry) => entry.id).toReversed())
  })

  it('goes on from the cursor when a session saved since then has moved to the front', () => {
    const sessions = many(PAGE_SIZE + 2)
    const first = session_page(sessions, undefined, undefined)
    const newer = summary('newer', '2026-10-28T00:00:00.000Z')
    const second = session_page([newer, ...sessions], undefined, first?.next_cursor)
    expect(second?.sessions.map((entry) => entry.id)).toEqual(['s1', 's0'])
  })

  it.each(['nope', '', Buffer.from('{"a":1}').toString('base64url'), Buffer.from('["only"]').toString('base64url'), Buffer.from('[1,2]').toString('base64url')])(
    'answers undefined for the cursor %j, which is not one of its own',
    (cursor) => {
      expect(session_page(many(3), undefined, cursor)).toBeUndefined()
    },
  )
})
