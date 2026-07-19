import { describe, expect, it } from 'vitest'

import { band_for_score, floor_score } from '../floor.js'
import { screen_files, scrub_text } from '../screen.js'
import { parse_unified_diff } from '../services/diff.js'
import { detect_signals } from '../signals.js'
import type { DiffFile } from '../types.js'

function file(path: string, added: ReadonlyArray<string> = []): DiffFile {
  return {
    path,
    status: 'modified',
    added_lines: added.map((content, i) => ({ line: i + 1, content })),
    removed_count: 0,
    raw: `diff --git a/${path} b/${path}\n${added.map((l) => `+${l}`).join('\n')}`,
  }
}

describe('detect_signals', () => {
  it('flags migrations, auth lines, and missing tests', () => {
    const signals = detect_signals([
      file('migrations/001_init.sql', ['CREATE TABLE t (id int);']),
      file('src/auth/guard.ts', ['if (!has_permission(user)) throw new Error()']),
    ])
    const ids = signals.map((s) => s.id)
    expect(ids).toContain('db-migration')
    expect(ids).toContain('auth-change')
    expect(ids).toContain('no-tests')
  })

  it('does not flag no-tests when tests change alongside code', () => {
    const signals = detect_signals([
      file('src/util.ts', ['export const x = 1']),
      file('src/__tests__/util.test.ts', ['expect(x).toBe(1)']),
    ])
    expect(signals.map((s) => s.id)).not.toContain('no-tests')
  })

  it('flags dependency and infra changes at medium severity', () => {
    const signals = detect_signals([file('package.json'), file('.github/workflows/ci.yml')])
    const by_id = new Map(signals.map((s) => [s.id, s]))
    expect(by_id.get('dependency-change')?.severity).toBe('medium')
    expect(by_id.get('infra-change')?.severity).toBe('medium')
  })
})

describe('floor_score / band_for_score', () => {
  it('raises the score to the highest applicable floor and never lowers it', () => {
    const auth = { id: 'auth-change', severity: 'high', detail: '', paths: [] } as const
    expect(floor_score(10, [auth])).toBe(50)
    expect(floor_score(80, [auth])).toBe(80)
    expect(floor_score(10, [])).toBe(10)
  })

  it('derives bands from quartiles', () => {
    expect(band_for_score(10)).toBe('low')
    expect(band_for_score(25)).toBe('medium')
    expect(band_for_score(50)).toBe('high')
    expect(band_for_score(75)).toBe('critical')
  })
})

describe('screen_files / scrub_text', () => {
  it('withholds fixture-like paths and scrubs PII from kept files', () => {
    const { screened, skipped } = screen_files([
      file('seeds/users.seed.json', ['{"email": "kim@example.com"}']),
      file('src/mailer.ts', ['send("kim@example.com", 5551234567)']),
    ])
    expect(skipped).toEqual(['seeds/users.seed.json'])
    expect(screened).toHaveLength(1)
    expect(screened[0]?.raw).not.toContain('kim@example.com')
    expect(screened[0]?.raw).toContain('[redacted-email]')
  })

  it('scrubs long digit runs but keeps short numbers', () => {
    expect(scrub_text('call 5551234567 ext 42')).toBe('call [redacted-number] ext 42')
  })
})

describe('parse_unified_diff', () => {
  it('extracts paths, status, and added line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1',
      '+const b = 2',
      ' const c = 3',
      '-const d = 4',
      '+const e = 5',
      '',
    ].join('\n')
    const files = parse_unified_diff(diff)
    expect(files).toHaveLength(1)
    expect(files[0]?.path).toBe('src/a.ts')
    expect(files[0]?.status).toBe('modified')
    expect(files[0]?.added_lines).toEqual([
      { line: 2, content: 'const b = 2' },
      { line: 4, content: 'const e = 5' },
    ])
    expect(files[0]?.removed_count).toBe(1)
  })
})
