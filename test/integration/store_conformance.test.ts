import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { durable, sequence, step, suspend, type CheckpointStore, type DurableStore } from 'fascicle'
import { filesystem_store, object_store } from 'fascicle/adapters'
import { checkpoint_store_conformance } from 'fascicle/testing'
import { z } from 'zod'
import { losing_answers, memory_client, type MemoryClient } from '../fixtures/memory_object_client.js'

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
  it('keeps the whole contract, with scopes, claims, and conditional writes', async () => {
    const report = await checkpoint_store_conformance(make_store, { corrupt: tear, ttl_ms: 60 })
    expect(report.failed).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.passed).toHaveLength(47)
  }, 30_000)

  it('holds a durable run through a start, a busy resume, and the drive that takes it up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fascicle-durable-'))
    const store = filesystem_store({ root_dir: dir })
    roots.set(store, dir)
    const flow = sequence([
      step('draft', (topic: string) => `${topic}: draft`),
      suspend({
        id: 'approve',
        on: () => {},
        resume_schema: z.object({ ok: z.boolean() }),
        combine: (draft: string, decision) => `${draft} ${decision.ok ? 'approved' : 'refused'}`,
      }),
    ])
    const quiet = { install_signal_handlers: false } as const
    const runs = durable({ store })
    expect(await runs.start('r', flow, 'pricing', quiet)).toMatchObject({ kind: 'suspended', id: 'approve' })
    await store.scope('r').claim('lease', 'another host', 60_000)
    expect(await runs.resume('r', flow, { approve: { ok: true } }, quiet)).toEqual({ kind: 'busy', run_id: 'r' })
    await store.scope('r').release('lease', 'another host')
    expect(await durable({ store }).resume('r', flow, {}, quiet)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'pricing: draft approved',
    })
  }, 30_000)

  it('keeps a stalled delivery away from a run deleted and started again with the same input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fascicle-durable-'))
    const base = filesystem_store({ root_dir: dir })
    roots.set(base, dir)
    // The first conditional write that carries a datum waits for `go`, which
    // holds a delivery between its read of the record and its write.
    const held = Promise.withResolvers<void>()
    const go = Promise.withResolvers<void>()
    let waiting = false
    const store: DurableStore = {
      scope: (prefix) => {
        const scope = base.scope(prefix)
        return {
          ...scope,
          set_if: async (key, value, expected) => {
            const inbox = (value as { inbox?: Record<string, unknown> }).inbox ?? {}
            if (!waiting && Object.keys(inbox).length > 0) {
              waiting = true
              held.resolve()
              await go.promise
            }
            return scope.set_if(key, value, expected)
          },
        }
      },
    }
    const flow = suspend({
      id: 'approve',
      on: () => {},
      resume_schema: z.object({ ok: z.boolean() }),
      combine: (draft: string, decision) => `${draft} ${decision.ok ? 'approved' : 'refused'}`,
    })
    const quiet = { install_signal_handlers: false } as const
    const runs = durable({ store })
    await runs.start('r', flow, 'same', quiet)
    const late = runs.resume('r', flow, { approve: { ok: false } }, quiet)
    await held.promise
    expect(await runs.delete('r')).toBe(true)
    // The file's hash is its version, and but for the nonce and the writer
    // the new run's record is the old one's bytes.
    expect(await runs.start('r', flow, 'same', quiet)).toMatchObject({ kind: 'suspended', id: 'approve' })
    go.resolve()
    expect(await late).toMatchObject({ kind: 'suspended', id: 'approve' })
    expect(await base.scope('r').get('record')).toMatchObject({ status: 'suspended', inbox: {}, resume_data: {} })
  }, 30_000)
})

describe('object_store against the store conformance suite', () => {
  // The client behind each store, so the damage hook can reach its bucket.
  const clients = new WeakMap<CheckpointStore, MemoryClient>()

  // Overwrite the object that holds `key` with a torn body. The store keeps a
  // short plain name at `<prefix>v/<name>`.
  async function tear_object(store: CheckpointStore, key: string): Promise<void> {
    const client = clients.get(store)
    if (client === undefined) throw new Error('corrupt was handed a store this suite never built')
    await client.put(`runs/v/${key}`, '{"torn')
  }

  it('keeps the whole contract over an in-memory client, a hashed long name included', async () => {
    const report = await checkpoint_store_conformance(
      () => {
        const client = memory_client()
        const store = object_store({ client, prefix: 'runs/' })
        clients.set(store, client)
        return store
      },
      { corrupt: tear_object, ttl_ms: 60 },
    )
    expect(report.failed).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.passed).toHaveLength(47)
  }, 30_000)

  it('keeps it when every conditional put that lands reports a failed condition', async () => {
    // The answer to each conditional put is lost, the way a retried put's is,
    // so the store has to tell its own landed write from a real conflict.
    const report = await checkpoint_store_conformance(
      () => {
        const client = memory_client()
        const store = object_store({ client: losing_answers(client), prefix: 'runs/' })
        clients.set(store, client)
        return store
      },
      { corrupt: tear_object, ttl_ms: 60 },
    )
    expect(report.failed).toEqual([])
    expect(report.skipped).toEqual([])
    expect(report.passed).toHaveLength(47)
  }, 30_000)
})
