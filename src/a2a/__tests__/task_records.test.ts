import { describe, expect, it, vi } from 'vitest'
import * as wire from '@a2a-js/sdk'
import type { Task, TaskState, TaskStatus } from '@a2a-js/sdk'
import { InMemoryTaskStore, ServerCallContext } from '@a2a-js/sdk/server'
import type { DurableRunState, DurableRuns } from '#core'
import { data_part, output_parts, text_part } from '../parts.js'
import { sight, STALE_SCAN_LIMIT, task_records } from '../task_records.js'
import type { Sighting } from '../task_records.js'
import { default_question, failure_message, gate_of } from '../task_status.js'

const STATE = wire.TaskState
const ann = new ServerCallContext({ user: { isAuthenticated: true, userName: 'ann' } })

type Harness = ReturnType<typeof harness>

// A task store over fake runs: each run state is whatever the test put in
// `states`, and `deleted` lists every delete the store asked for.
function harness(options: { live?: boolean; delete_refused?: boolean } = {}) {
  const states = new Map<string, DurableRunState>()
  const deleted: string[] = []
  const got: string[] = []
  let refuse = options.delete_refused === true
  const runs: DurableRuns = {
    start: () => Promise.reject(new Error('not used')),
    resume: () => Promise.reject(new Error('not used')),
    get: async (run_id) => {
      got.push(run_id)
      return states.get(run_id)
    },
    delete: async (run_id) => {
      deleted.push(run_id)
      if (refuse) return false
      states.delete(run_id)
      return true
    },
  }
  const inner = new InMemoryTaskStore()
  const saves = vi.spyOn(inner, 'save')
  const records = task_records({
    wire,
    inner,
    runs,
    hooks: {
      gates: (gate) => (gate === 'ci' ? 'external' : 'client'),
      to_question: default_question,
      to_failure: (err) => `failed: ${failure_message(err)}`,
    },
    to_parts: output_parts,
    is_live: () => options.live === true,
  })
  return {
    records,
    inner,
    states,
    deleted,
    got,
    saves,
    allow_delete: () => {
      refuse = false
    },
  }
}

function task(state: TaskState, options: { gate?: string; id?: string } = {}): Task {
  const id = options.id ?? 'task-1'
  return {
    id,
    contextId: 'ctx-1',
    status: {
      state,
      message:
        options.gate === undefined
          ? undefined
          : {
              messageId: 'm0',
              contextId: 'ctx-1',
              taskId: id,
              role: wire.Role.ROLE_AGENT,
              parts: [text_part('an earlier status')],
              metadata: { fascicle: { gate: options.gate } },
              extensions: [],
              referenceTaskIds: [],
            },
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    artifacts: [],
    history: [],
    metadata: undefined,
  }
}

async function seeded(h: Harness, stored: Task): Promise<void> {
  await h.inner.save(stored, ann)
  h.saves.mockClear()
}

describe('task_records load', () => {
  it('resolves nothing for a task the store never saw, without asking the runs', async () => {
    const h = harness()
    expect(await h.records.store.load('missing', ann)).toBeUndefined()
    expect(h.got).toEqual([])
    expect(h.records.seen.size).toBe(0)
  })

  it('leaves a task alone while this process is driving it', async () => {
    const h = harness({ live: true })
    await seeded(h, task(STATE.TASK_STATE_WORKING))
    h.states.set('task-1', { kind: 'done', run_id: 'task-1', output: 'finished' })
    expect((await h.records.store.load('task-1', ann))?.status?.state).toBe(STATE.TASK_STATE_WORKING)
    expect(h.got).toEqual([])
    expect(h.saves).not.toHaveBeenCalled()
    expect(h.records.seen.get('task-1')).toEqual({ context: ann, context_id: 'ctx-1' })
  })

  it('leaves a task alone when it has no run', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_WORKING))
    expect(await h.records.store.load('task-1', ann)).toEqual(task(STATE.TASK_STATE_WORKING))
    expect(h.got).toEqual(['task-1'])
    expect(h.saves).not.toHaveBeenCalled()
  })

  it('deletes the run of a terminal task once, and forgets who the task belonged to', async () => {
    const h = harness()
    await h.records.store.save(task(STATE.TASK_STATE_WORKING), ann)
    expect(h.records.seen.has('task-1')).toBe(true)
    await h.inner.save(task(STATE.TASK_STATE_FAILED), ann)

    expect((await h.records.store.load('task-1', ann))?.status?.state).toBe(STATE.TASK_STATE_FAILED)
    await h.records.store.load('task-1', ann)

    expect(h.deleted).toEqual(['task-1'])
    expect(h.got).toEqual([])
    expect(h.records.seen.has('task-1')).toBe(false)
  })

  it('asks again at the next load when the run could not be deleted yet', async () => {
    const h = harness({ delete_refused: true })
    await seeded(h, task(STATE.TASK_STATE_CANCELED))
    await h.records.store.load('task-1', ann)
    await h.records.store.load('task-1', ann)
    expect(h.deleted).toEqual(['task-1', 'task-1'])
    h.allow_delete()
    await h.records.store.load('task-1', ann)
    await h.records.store.load('task-1', ann)
    expect(h.deleted).toEqual(['task-1', 'task-1', 'task-1'])
  })
})

describe('task_records reconciling a record with its run', () => {
  it('completes a task whose run finished, with the output as a new artifact, and deletes the run', async () => {
    const h = harness()
    const stored = task(STATE.TASK_STATE_WORKING)
    stored.artifacts.push({ artifactId: 'earlier', name: '', description: '', parts: [text_part('lead-up')], metadata: undefined, extensions: [] })
    await seeded(h, stored)
    h.states.set('task-1', { kind: 'done', run_id: 'task-1', output: { score: 3 } })
    const before = Date.now()

    const loaded = await h.records.store.load('task-1', ann)

    expect(loaded?.status?.state).toBe(STATE.TASK_STATE_COMPLETED)
    expect(loaded?.status?.message).toBeUndefined()
    expect(Date.parse(loaded?.status?.timestamp ?? '')).toBeGreaterThanOrEqual(before)
    expect(loaded?.artifacts).toHaveLength(2)
    expect(loaded?.artifacts[0]?.artifactId).toBe('earlier')
    expect(loaded?.artifacts[1]).toEqual({
      artifactId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: '',
      description: '',
      parts: [data_part({ score: 3 })],
      metadata: undefined,
      extensions: [],
    })
    expect(loaded?.history).toEqual([])
    expect(await h.inner.load('task-1', ann)).toEqual(loaded)
    expect(h.deleted).toEqual(['task-1'])
    expect(h.records.seen.has('task-1')).toBe(false)
  })

  it('adds no artifact for a run that finished with nothing', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_WORKING))
    h.states.set('task-1', { kind: 'done', run_id: 'task-1', output: undefined })
    const loaded = await h.records.store.load('task-1', ann)
    expect(loaded?.status?.state).toBe(STATE.TASK_STATE_COMPLETED)
    expect(loaded?.artifacts).toEqual([])
  })

  it('fails a task whose run failed, with what to_failure makes of the run error', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_WORKING))
    h.states.set('task-1', { kind: 'failed', run_id: 'task-1', error: 'the drive blew up' })
    const loaded = await h.records.store.load('task-1', ann)
    expect(loaded?.status?.state).toBe(STATE.TASK_STATE_FAILED)
    expect(loaded?.status?.message?.parts).toEqual([text_part('failed: the drive blew up')])
    expect(loaded?.history).toEqual([loaded?.status?.message])
    expect(loaded?.artifacts).toEqual([])
    expect(h.deleted).toEqual(['task-1'])
  })

  it('asks the question of a run that reached a client gate, for the task and context it belongs to', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_WORKING))
    h.states.set('task-1', { kind: 'suspended', run_id: 'task-1', id: 'approve', payload: { input: 'draft' }, deadline_at: 99 })

    const loaded = await h.records.store.load('task-1', ann)

    expect(loaded?.status?.state).toBe(STATE.TASK_STATE_INPUT_REQUIRED)
    expect(loaded?.status?.message).toMatchObject({
      taskId: 'task-1',
      contextId: 'ctx-1',
      parts: [text_part('Waiting for input at "approve".'), data_part({ input: 'draft' })],
      metadata: { fascicle: { gate: 'approve', deadline_at: 99 } },
    })
    expect(loaded?.history).toEqual([loaded?.status?.message])
    expect(loaded?.artifacts).toEqual([])
    expect(h.deleted).toEqual([])
    expect(h.saves).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when the record already names the gate its run waits at', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_INPUT_REQUIRED, { gate: 'approve' }))
    h.states.set('task-1', { kind: 'suspended', run_id: 'task-1', id: 'approve', payload: null })
    expect(await h.records.store.load('task-1', ann)).toEqual(task(STATE.TASK_STATE_INPUT_REQUIRED, { gate: 'approve' }))
    expect(h.saves).not.toHaveBeenCalled()
  })

  it('updates a waiting record whose run moved on to another gate', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_INPUT_REQUIRED, { gate: 'first' }))
    h.states.set('task-1', { kind: 'suspended', run_id: 'task-1', id: 'second', payload: null })
    const loaded = await h.records.store.load('task-1', ann)
    expect(loaded && gate_of(loaded)).toBe('second')
    expect(loaded?.status?.state).toBe(STATE.TASK_STATE_INPUT_REQUIRED)
    expect(h.saves).toHaveBeenCalledTimes(1)
  })

  it('updates a record that names the right gate in the wrong state', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_WORKING, { gate: 'approve' }))
    h.states.set('task-1', { kind: 'suspended', run_id: 'task-1', id: 'approve', payload: null })
    const loaded = await h.records.store.load('task-1', ann)
    expect(loaded?.status?.state).toBe(STATE.TASK_STATE_INPUT_REQUIRED)
    expect(h.saves).toHaveBeenCalledTimes(1)
  })

  it('reads an external gate as WORKING with its note, and leaves a record that already says so', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_INPUT_REQUIRED, { gate: 'approve' }))
    h.states.set('task-1', { kind: 'suspended', run_id: 'task-1', id: 'ci', payload: null })
    const loaded = await h.records.store.load('task-1', ann)
    expect(loaded?.status?.state).toBe(STATE.TASK_STATE_WORKING)
    expect(loaded && gate_of(loaded)).toBe('ci')
    h.saves.mockClear()
    await h.records.store.load('task-1', ann)
    expect(h.saves).not.toHaveBeenCalled()
  })

  it('reads a waiting record as WORKING once its run is being driven, with no message and no history', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_INPUT_REQUIRED, { gate: 'approve' }))
    h.states.set('task-1', { kind: 'running', run_id: 'task-1' })
    const before = Date.now()
    const loaded = await h.records.store.load('task-1', ann)
    expect(loaded?.status?.state).toBe(STATE.TASK_STATE_WORKING)
    expect(loaded?.status?.message).toBeUndefined()
    expect(Date.parse(loaded?.status?.timestamp ?? '')).toBeGreaterThanOrEqual(before)
    expect(loaded?.history).toEqual([])
    expect(loaded?.artifacts).toEqual([])
  })

  it.each([STATE.TASK_STATE_WORKING, STATE.TASK_STATE_SUBMITTED])(
    'leaves a record in state %s alone while its run is being driven',
    async (state) => {
      const h = harness()
      await seeded(h, task(state))
      h.states.set('task-1', { kind: 'running', run_id: 'task-1' })
      expect(await h.records.store.load('task-1', ann)).toEqual(task(state))
      expect(h.saves).not.toHaveBeenCalled()
    },
  )
})

describe('task_records save', () => {
  it('saves through to the inner store, and remembers who the task belongs to', async () => {
    const h = harness()
    await h.records.store.save(task(STATE.TASK_STATE_WORKING), ann)
    expect(await h.inner.load('task-1', ann)).toEqual(task(STATE.TASK_STATE_WORKING))
    expect(h.records.seen.get('task-1')).toEqual({ context: ann, context_id: 'ctx-1' })
    expect(h.deleted).toEqual([])
  })

  it('deletes the run when a save makes the task terminal', async () => {
    const h = harness()
    h.states.set('task-1', { kind: 'failed', run_id: 'task-1', error: 'x' })
    await h.records.store.save(task(STATE.TASK_STATE_WORKING), ann)
    await h.records.store.save(task(STATE.TASK_STATE_COMPLETED), ann)
    expect(h.deleted).toEqual(['task-1'])
    expect(h.states.has('task-1')).toBe(false)
    expect(h.records.seen.has('task-1')).toBe(false)
  })

  it('refuses every save of a task after the one that ended it', async () => {
    const h = harness()
    await h.records.store.save(task(STATE.TASK_STATE_CANCELED), ann)
    const late = task(STATE.TASK_STATE_CANCELED)
    late.artifacts.push({ artifactId: 'late', name: '', description: '', parts: [text_part('too late')], metadata: undefined, extensions: [] })
    await h.records.store.save(late, ann)
    await h.records.store.save(task(STATE.TASK_STATE_WORKING), ann)
    expect(await h.inner.load('task-1', ann)).toEqual(task(STATE.TASK_STATE_CANCELED))
    expect(h.saves).toHaveBeenCalledTimes(1)
    expect(h.records.seen.has('task-1')).toBe(false)
  })

  it('refuses a save of a task that a load found ended by someone else', async () => {
    const h = harness()
    await h.records.store.save(task(STATE.TASK_STATE_WORKING), ann)
    await h.inner.save(task(STATE.TASK_STATE_CANCELED), ann)
    await h.records.store.load('task-1', ann)
    h.saves.mockClear()
    await h.records.store.save(task(STATE.TASK_STATE_COMPLETED), ann)
    expect(h.saves).not.toHaveBeenCalled()
    expect((await h.inner.load('task-1', ann))?.status?.state).toBe(STATE.TASK_STATE_CANCELED)
  })

  it('keeps tasks apart: ending one leaves another writable', async () => {
    const h = harness()
    await h.records.store.save(task(STATE.TASK_STATE_COMPLETED, { id: 'done' }), ann)
    await h.records.store.save(task(STATE.TASK_STATE_WORKING, { id: 'live' }), ann)
    await h.records.store.save(task(STATE.TASK_STATE_INPUT_REQUIRED, { id: 'live' }), ann)
    expect((await h.inner.load('live', ann))?.status?.state).toBe(STATE.TASK_STATE_INPUT_REQUIRED)
  })

})

describe('task_records list', () => {
  const page = (h: Harness, options: { artifacts?: boolean; status?: TaskState } = {}) =>
    h.records.store.list(
      {
        tenant: '',
        contextId: '',
        status: options.status ?? STATE.TASK_STATE_UNSPECIFIED,
        pageToken: '',
        statusTimestampAfter: undefined,
        includeArtifacts: options.artifacts,
      },
      ann,
    )

  it('lists a task as stored when its run has nothing new to say', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_WORKING))
    const listed = await page(h)
    expect(listed.tasks).toEqual([task(STATE.TASK_STATE_WORKING)])
    expect(h.got).toEqual(['task-1'])
    expect(h.saves).not.toHaveBeenCalled()
  })

  it('lists a task whose run finished elsewhere as completed, and writes the record', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_WORKING))
    h.states.set('task-1', { kind: 'done', run_id: 'task-1', output: 'shipped' })

    const listed = await page(h, { artifacts: true })
    expect(listed.tasks.map((found) => found.status?.state)).toEqual([STATE.TASK_STATE_COMPLETED])
    expect(listed.tasks[0]?.artifacts.map((artifact) => artifact.parts)).toEqual([[text_part('shipped')]])
    expect((await h.inner.load('task-1', ann))?.status?.state).toBe(STATE.TASK_STATE_COMPLETED)
    expect(h.deleted).toEqual(['task-1'])
  })

  it('keeps artifacts off a page that asked for none, and in the record all the same', async () => {
    const h = harness()
    const stored = task(STATE.TASK_STATE_WORKING)
    stored.artifacts.push({ artifactId: 'a1', name: '', description: '', parts: [text_part('draft')], metadata: undefined, extensions: [] })
    await seeded(h, stored)
    h.states.set('task-1', { kind: 'done', run_id: 'task-1', output: 'shipped' })

    const listed = await page(h)
    expect(listed.tasks.map((found) => found.status?.state)).toEqual([STATE.TASK_STATE_COMPLETED])
    expect(listed.tasks[0]?.artifacts).toEqual([])
    const kept = await h.inner.load('task-1', ann)
    expect(kept?.artifacts.map((artifact) => artifact.parts)).toEqual([[text_part('draft')], [text_part('shipped')]])
  })

  it('leaves a terminal task and a task this process drives alone, without asking the runs', async () => {
    const ended = harness()
    await seeded(ended, task(STATE.TASK_STATE_FAILED))
    ended.states.set('task-1', { kind: 'done', run_id: 'task-1', output: 'late' })
    const ended_loads = vi.spyOn(ended.inner, 'load')
    expect((await page(ended)).tasks).toEqual([task(STATE.TASK_STATE_FAILED)])
    expect(ended.got).toEqual([])
    expect(ended_loads).not.toHaveBeenCalled()

    const live = harness({ live: true })
    await seeded(live, task(STATE.TASK_STATE_WORKING))
    live.states.set('task-1', { kind: 'done', run_id: 'task-1', output: 'not yet' })
    const live_loads = vi.spyOn(live.inner, 'load')
    expect((await page(live)).tasks).toEqual([task(STATE.TASK_STATE_WORKING)])
    expect(live_loads).not.toHaveBeenCalled()
    expect(live.got).toEqual([])
    expect(live.saves).not.toHaveBeenCalled()
  })

  it('passes the page through with everything else the inner store answered', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_WORKING, { id: 'a' }))
    await h.inner.save(task(STATE.TASK_STATE_COMPLETED, { id: 'b' }), ann)
    const inner_page = await h.inner.list(
      { tenant: '', contextId: '', status: STATE.TASK_STATE_UNSPECIFIED, pageToken: '', statusTimestampAfter: undefined },
      ann,
    )
    const listed = await page(h)
    expect({ ...listed, tasks: [] }).toEqual({ ...inner_page, tasks: [] })
    expect(listed.tasks.map((found) => found.id).toSorted()).toEqual(['a', 'b'])
  })
})

describe('task_records list with a status filter', () => {
  const filtered = (h: Harness, status: TaskState, more: { contextId?: string; statusTimestampAfter?: string } = {}) =>
    h.records.store.list(
      { tenant: '', contextId: '', pageToken: '', statusTimestampAfter: undefined, includeArtifacts: true, ...more, status },
      ann,
    )
  const ids_of = (listed: { tasks: Task[] }): string[] => listed.tasks.map((found) => found.id).toSorted()

  it('finds a task whose run finished elsewhere under COMPLETED, though its record still said working', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_WORKING))
    h.states.set('task-1', { kind: 'done', run_id: 'task-1', output: 'shipped' })

    const listed = await filtered(h, STATE.TASK_STATE_COMPLETED)

    expect(listed.tasks.map((found) => found.status?.state)).toEqual([STATE.TASK_STATE_COMPLETED])
    expect(listed.tasks[0]?.artifacts.map((artifact) => artifact.parts)).toEqual([[text_part('shipped')]])
    expect(listed.totalSize).toBe(1)
    expect(h.deleted).toEqual(['task-1'])
  })

  it('brings a task up to date from each state a task can still leave', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_SUBMITTED, { id: 'submitted' }))
    await seeded(h, task(STATE.TASK_STATE_WORKING, { id: 'working' }))
    await seeded(h, task(STATE.TASK_STATE_INPUT_REQUIRED, { id: 'waiting', gate: 'approve' }))
    for (const id of ['submitted', 'working', 'waiting']) h.states.set(id, { kind: 'failed', run_id: id, error: 'broke' })

    expect(ids_of(await filtered(h, STATE.TASK_STATE_FAILED))).toEqual(['submitted', 'waiting', 'working'])
  })

  it('keeps a task off the page of a state its run has left, and reads each stale task once', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_WORKING, { id: 'gone' }))
    await seeded(h, task(STATE.TASK_STATE_WORKING, { id: 'still' }))
    h.states.set('gone', { kind: 'done', run_id: 'gone', output: 'shipped' })
    h.states.set('still', { kind: 'running', run_id: 'still' })

    const listed = await filtered(h, STATE.TASK_STATE_WORKING)

    expect(ids_of(listed)).toEqual(['still'])
    expect(listed.totalSize).toBe(1)
    expect(h.got.toSorted()).toEqual(['gone', 'still'])
  })

  it('reads no run for a terminal task, or for one this process drives', async () => {
    const ended = harness()
    await seeded(ended, task(STATE.TASK_STATE_COMPLETED))
    ended.states.set('task-1', { kind: 'failed', run_id: 'task-1', error: 'late' })
    expect(ids_of(await filtered(ended, STATE.TASK_STATE_COMPLETED))).toEqual(['task-1'])
    expect(ids_of(await filtered(ended, STATE.TASK_STATE_FAILED))).toEqual([])
    expect(ended.got).toEqual([])

    const live = harness({ live: true })
    await seeded(live, task(STATE.TASK_STATE_WORKING))
    live.states.set('task-1', { kind: 'done', run_id: 'task-1', output: 'not yet' })
    expect(ids_of(await filtered(live, STATE.TASK_STATE_COMPLETED))).toEqual([])
    expect(ids_of(await filtered(live, STATE.TASK_STATE_WORKING))).toEqual(['task-1'])
    expect(live.got).toEqual([])
    expect(live.saves).not.toHaveBeenCalled()
  })

  it('scans within the request context, and past its time window', async () => {
    const h = harness()
    await seeded(h, task(STATE.TASK_STATE_WORKING, { id: 'mine' }))
    await seeded(h, { ...task(STATE.TASK_STATE_WORKING, { id: 'other' }), contextId: 'ctx-2' })
    h.states.set('mine', { kind: 'done', run_id: 'mine', output: 'shipped' })
    h.states.set('other', { kind: 'done', run_id: 'other', output: 'shipped' })

    // Both records were stamped before the window opens, and catching up stamps `mine` now.
    const listed = await filtered(h, STATE.TASK_STATE_COMPLETED, {
      contextId: 'ctx-1',
      statusTimestampAfter: '2026-06-01T00:00:00.000Z',
    })

    expect(ids_of(listed)).toEqual(['mine'])
    expect(h.got).toEqual(['mine'])
    expect((await h.inner.load('other', ann))?.status?.state).toBe(STATE.TASK_STATE_WORKING)
  })

  it('brings up to date no more than the limit in one state, most recently changed first', async () => {
    const h = harness()
    const count = STALE_SCAN_LIMIT + 1
    for (let n = 0; n < count; n += 1) {
      const id = `t${String(n).padStart(3, '0')}`
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()
      const stored = task(STATE.TASK_STATE_WORKING, { id })
      await h.inner.save({ ...stored, status: { state: STATE.TASK_STATE_WORKING, message: undefined, timestamp: stamp } }, ann)
      h.states.set(id, { kind: 'done', run_id: id, output: 'shipped' })
    }
    h.saves.mockClear()

    const first = await filtered(h, STATE.TASK_STATE_COMPLETED)
    expect(first.totalSize).toBe(STALE_SCAN_LIMIT)
    expect(h.got).toHaveLength(STALE_SCAN_LIMIT)
    // The oldest record is the one past the limit, and it stays as stored.
    expect(h.got).not.toContain('t000')
    expect((await h.inner.load('t000', ann))?.status?.state).toBe(STATE.TASK_STATE_WORKING)

    // The next request finds it, since the others have left the state it sits in.
    expect((await filtered(h, STATE.TASK_STATE_COMPLETED)).totalSize).toBe(count)
  })

  it('drops a task that catches up on the page into a state the filter did not ask for', async () => {
    const h = harness()
    const count = STALE_SCAN_LIMIT + 1
    for (let n = 0; n < count; n += 1) {
      const id = `t${String(n).padStart(3, '0')}`
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()
      const stored = task(STATE.TASK_STATE_WORKING, { id })
      await h.inner.save({ ...stored, status: { state: STATE.TASK_STATE_WORKING, message: undefined, timestamp: stamp } }, ann)
      h.states.set(id, { kind: 'done', run_id: id, output: 'shipped' })
    }

    // Every scanned task leaves WORKING, so the stored page holds only the one past the limit.
    const listed = await filtered(h, STATE.TASK_STATE_WORKING)
    expect(listed.tasks).toEqual([])
    expect((await h.inner.load('t000', ann))?.status?.state).toBe(STATE.TASK_STATE_COMPLETED)
  })
})

describe('sight', () => {
  const at = (context_id: string): Sighting => ({ context: ann, context_id })

  it('forgets the oldest sighting once more than the limit are held', () => {
    const seen = new Map<string, Sighting>()
    sight(seen, 'a', at('1'), 2)
    sight(seen, 'b', at('2'), 2)
    expect([...seen.keys()]).toEqual(['a', 'b'])
    sight(seen, 'c', at('3'), 2)
    expect([...seen.keys()]).toEqual(['b', 'c'])
  })

  it('counts a task seen again as the newest, with its latest sighting', () => {
    const seen = new Map<string, Sighting>()
    sight(seen, 'a', at('1'), 2)
    sight(seen, 'b', at('2'), 2)
    sight(seen, 'a', at('4'), 2)
    expect(seen.size).toBe(2)
    sight(seen, 'c', at('3'), 2)
    expect([...seen.keys()]).toEqual(['a', 'c'])
    expect(seen.get('a')).toEqual(at('4'))
  })
})

describe('task_records saved', () => {
  const status = (state: TaskState, timestamp: string): TaskStatus => ({ state, message: undefined, timestamp })
  const with_status = (next: TaskStatus): Task => ({ ...task(STATE.TASK_STATE_WORKING), status: next })

  // Whether a promise has settled, without waiting on it.
  async function settled(promise: Promise<void>): Promise<boolean> {
    let done = false
    void promise.then(() => {
      done = true
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    return done
  }

  it('resolves once the task is saved in that state at that time, and not before', async () => {
    const h = harness()
    const awaited = status(STATE.TASK_STATE_INPUT_REQUIRED, '2026-01-01T00:00:05.000Z')
    const waiting = h.records.saved('task-1', awaited, 60_000)

    await h.records.store.save(with_status(status(STATE.TASK_STATE_WORKING, '2026-01-01T00:00:05.000Z')), ann)
    expect(await settled(waiting)).toBe(false)
    await h.records.store.save(with_status(status(STATE.TASK_STATE_INPUT_REQUIRED, '2026-01-01T00:00:04.000Z')), ann)
    expect(await settled(waiting)).toBe(false)
    await h.records.store.save({ ...with_status(awaited), id: 'another-task' }, ann)
    expect(await settled(waiting)).toBe(false)

    await h.records.store.save(with_status(awaited), ann)
    expect(await settled(waiting)).toBe(true)
  })

  it('resolves every waiter on the same status, and each only once it matches', async () => {
    const h = harness()
    const first = status(STATE.TASK_STATE_WORKING, '2026-01-01T00:00:01.000Z')
    const second = status(STATE.TASK_STATE_COMPLETED, '2026-01-01T00:00:02.000Z')
    const waits = [h.records.saved('task-1', first, 60_000), h.records.saved('task-1', first, 60_000), h.records.saved('task-1', second, 60_000)]
    await h.records.store.save(with_status(first), ann)
    expect(await Promise.all(waits.map(settled))).toEqual([true, true, false])
    await h.records.store.save(with_status(second), ann)
    expect(await settled(waits[2] as Promise<void>)).toBe(true)
  })

  it('gives up after the timeout when no save comes', async () => {
    const h = harness()
    const started = Date.now()
    await h.records.saved('task-1', status(STATE.TASK_STATE_COMPLETED, '2026-01-01T00:00:00.000Z'), 30)
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('resolves at once for a task the store has seen ended, whose saves it refuses', async () => {
    const h = harness()
    const late = status(STATE.TASK_STATE_COMPLETED, '2026-01-01T00:00:09.000Z')
    const before = h.records.saved('task-1', late, 60_000)
    expect(await settled(before)).toBe(false)

    await h.records.store.save(task(STATE.TASK_STATE_CANCELED), ann)
    expect(await settled(before)).toBe(false)
    expect(await settled(h.records.saved('task-1', late, 60_000))).toBe(true)
    expect(await settled(h.records.saved('another-task', late, 60_000))).toBe(false)
  })
})
