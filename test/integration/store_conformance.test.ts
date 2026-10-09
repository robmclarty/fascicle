import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { CheckpointStore } from 'fascicle'
import { filesystem_store } from 'fascicle/adapters'
import { checkpoint_store_conformance } from 'fascicle/testing'

// Every directory a store was rooted in, by store, so the damage hook can
// find a value's file and the suite can clean up after itself.
const roots = new Map<CheckpointStore, string>()

afterAll(() => {
  for (const dir of roots.values()) rmSync(dir, { recursive: true, force: true })
})

function make_store(): CheckpointStore {
  const dir = mkdtempSync(join(tmpdir(), 'fascicle-conformance-'))
  const store: CheckpointStore = filesystem_store({ root_dir: dir })
  roots.set(store, dir)
  return store
}

// Overwrite the value file for `key` with half a JSON document, the way a
// write torn by a crash would leave it.
function tear(store: CheckpointStore, key: string): void {
  const dir = roots.get(store) ?? ''
  const file = readdirSync(dir).find((name) => name.startsWith(`${key}.`) && name.endsWith('.json'))
  if (file === undefined) throw new Error(`no value file for ${key} in ${dir}`)
  writeFileSync(join(dir, file), '{ "ok": tr')
}

describe('filesystem_store against the store conformance suite', () => {
  it('keeps the whole contract, scopes and claims included', async () => {
    const report = await checkpoint_store_conformance(make_store, { corrupt: tear, ttl_ms: 60 })
    expect(report.failed).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.passed).toHaveLength(31)
  })
})
