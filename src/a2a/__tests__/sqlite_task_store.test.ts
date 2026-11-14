import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TaskState } from '@a2a-js/sdk'
import type { ListTasksRequest, Task } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { sqlite_store } from '#adapters'
import { sqlite_task_store } from '../sqlite_task_store.js'

const dirs: string[] = []
const closers: Array<() => void> = []

afterAll(() => {
  for (const close of closers) close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function fresh_file(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fascicle-a2a-tasks-'))
  dirs.push(dir)
  return join(dir, 'agent.db')
}

function open_store(path = ':memory:') {
  const store = sqlite_task_store({ path })
  closers.push(store.close)
  return store
}

function caller(name: string, tenant?: string): ServerCallContext {
  return new ServerCallContext({
    user: { isAuthenticated: name !== '', userName: name },
    ...(tenant === undefined ? {} : { tenant }),
  })
}

function task(id: string, options: { context?: string; state?: TaskState; at?: string } = {}): Task {
  return {
    id,
    contextId: options.context ?? 'ctx',
    status: {
      state: options.state ?? TaskState.TASK_STATE_WORKING,
      message: undefined,
      timestamp: options.at ?? '2026-01-01T00:00:00.000Z',
    },
    artifacts: [
      {
        artifactId: `${id}-art`,
        name: '',
        description: '',
        parts: [{ content: { $case: 'text', value: `output of ${id}` }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
        metadata: undefined,
        extensions: [],
      },
    ],
    history: [],
    metadata: undefined,
  }
}

function list_params(overrides: Partial<ListTasksRequest> = {}): ListTasksRequest {
  return {
    tenant: '',
    contextId: '',
    status: TaskState.TASK_STATE_UNSPECIFIED,
    pageToken: '',
    statusTimestampAfter: undefined,
    ...overrides,
  }
}

const ann = caller('ann')

describe('sqlite_task_store load and save', () => {
  it('reads back the task it saved, and nothing for an id it never saw', async () => {
    const store = open_store()
    await store.save(task('t1'), ann)
    expect(await store.load('t1', ann)).toEqual(task('t1'))
    expect(await store.load('missing', ann)).toBeUndefined()
  })

  it('overwrites a task saved again under the same id', async () => {
    const store = open_store()
    await store.save(task('t1'), ann)
    await store.save(task('t1', { state: TaskState.TASK_STATE_COMPLETED, context: 'moved' }), ann)
    const loaded = await store.load('t1', ann)
    expect(loaded?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(loaded?.contextId).toBe('moved')
    expect((await store.list(list_params(), ann)).totalSize).toBe(1)
  })

  it('keeps raw bytes in a part as bytes', async () => {
    const store = open_store()
    const with_bytes = task('t1')
    with_bytes.artifacts[0]?.parts.push({
      content: { $case: 'raw', value: Buffer.from([0, 255, 7]) },
      metadata: undefined,
      filename: 'blob',
      mediaType: 'application/octet-stream',
    })
    await store.save(with_bytes, ann)
    const content = (await store.load('t1', ann))?.artifacts[0]?.parts[1]?.content
    if (content?.$case !== 'raw') throw new Error(`expected raw bytes, got ${content?.$case}`)
    expect(Buffer.isBuffer(content.value)).toBe(true)
    expect([...content.value]).toEqual([0, 255, 7])
  })

  it('keeps a task with no status, which lists as unspecified with no time', async () => {
    const store = open_store()
    await store.save({ ...task('t1'), status: undefined }, ann)
    expect((await store.load('t1', ann))?.id).toBe('t1')
    const recent = await store.list(list_params({ statusTimestampAfter: '2000-01-01T00:00:00.000Z' }), ann)
    expect(recent.tasks).toEqual([])
  })

  it('keeps what it saved for the next store over the same file', async () => {
    const path = fresh_file()
    const first = sqlite_task_store({ path })
    await first.save(task('t1'), ann)
    first.close()
    expect(await open_store(path).load('t1', ann)).toEqual(task('t1'))
  })

  it('shares one file with a sqlite_store, each in tables of its own', async () => {
    const path = fresh_file()
    const runs = sqlite_store({ path })
    closers.push(runs.close)
    const tasks = open_store(path)
    await runs.scope('t1').set('record', { status: 'running' })
    await tasks.save(task('t1'), ann)
    expect(await runs.scope('t1').get('record')).toEqual({ status: 'running' })
    expect(await tasks.load('t1', ann)).toEqual(task('t1'))
  })
})

describe('sqlite_task_store scoping', () => {
  it('keeps one caller from loading or listing another caller\'s task', async () => {
    const store = open_store()
    await store.save(task('t1'), ann)
    const bob = caller('bob')
    expect(await store.load('t1', bob)).toBeUndefined()
    expect((await store.list(list_params(), bob)).tasks).toEqual([])
    expect((await store.list(list_params(), bob)).totalSize).toBe(0)
    await store.save(task('t1', { context: "bob's" }), bob)
    expect((await store.load('t1', ann))?.contextId).toBe('ctx')
    expect((await store.load('t1', bob))?.contextId).toBe("bob's")
  })

  it('keeps tenants apart, and every anonymous caller in one scope', async () => {
    const store = open_store()
    await store.save(task('t1'), caller('ann', 'acme'))
    expect(await store.load('t1', caller('ann', 'globex'))).toBeUndefined()
    expect(await store.load('t1', ann)).toBeUndefined()
    expect((await store.load('t1', caller('ann', 'acme')))?.id).toBe('t1')

    await store.save(task('t2'), new ServerCallContext())
    expect((await store.load('t2', caller('')))?.id).toBe('t2')
    expect(await store.load('t2', ann)).toBeUndefined()
  })
})

describe('sqlite_task_store list', () => {
  async function seeded() {
    const store = open_store()
    await store.save(task('a', { at: '2026-01-01T00:00:01.000Z', context: 'one' }), ann)
    await store.save(task('b', { at: '2026-01-01T00:00:03.000Z', context: 'two', state: TaskState.TASK_STATE_COMPLETED }), ann)
    await store.save(task('c', { at: '2026-01-01T00:00:02.000Z', context: 'one', state: TaskState.TASK_STATE_COMPLETED }), ann)
    await store.save(task('d', { at: '2026-01-01T00:00:02.000Z', context: 'one' }), ann)
    return store
  }

  const ids = (tasks: ReadonlyArray<Task>): string[] => tasks.map((listed) => listed.id)

  it('lists newest first, breaking a tie on the id, and counts them all', async () => {
    const listed = await (await seeded()).list(list_params(), ann)
    expect(ids(listed.tasks)).toEqual(['b', 'd', 'c', 'a'])
    expect(listed).toMatchObject({ totalSize: 4, pageSize: 50, nextPageToken: '' })
  })

  it('filters by context, by state, and by the time of the status', async () => {
    const store = await seeded()
    expect(ids((await store.list(list_params({ contextId: 'one' }), ann)).tasks)).toEqual(['d', 'c', 'a'])
    const completed = await store.list(list_params({ status: TaskState.TASK_STATE_COMPLETED }), ann)
    expect(ids(completed.tasks)).toEqual(['b', 'c'])
    expect(completed.totalSize).toBe(2)
    const recent = await store.list(list_params({ statusTimestampAfter: '2026-01-01T00:00:02.000Z' }), ann)
    expect(ids(recent.tasks)).toEqual(['b'])
    const both = await store.list(list_params({ contextId: 'one', status: TaskState.TASK_STATE_COMPLETED }), ann)
    expect(ids(both.tasks)).toEqual(['c'])
  })

  it('ignores a time filter that is not a date', async () => {
    const listed = await (await seeded()).list(list_params({ statusTimestampAfter: 'not a date' }), ann)
    expect(listed.totalSize).toBe(4)
  })

  it('pages with a cursor until the tasks run out, counting the whole set on every page', async () => {
    const store = await seeded()
    const first = await store.list(list_params({ pageSize: 2 }), ann)
    expect(ids(first.tasks)).toEqual(['b', 'd'])
    expect(first).toMatchObject({ pageSize: 2, totalSize: 4 })
    expect(first.nextPageToken).not.toBe('')

    const second = await store.list(list_params({ pageSize: 2, pageToken: first.nextPageToken }), ann)
    expect(ids(second.tasks)).toEqual(['c', 'a'])
    expect(second).toMatchObject({ totalSize: 4, nextPageToken: '' })

    const third = await store.list(list_params({ pageSize: 3 }), ann)
    expect(ids(third.tasks)).toEqual(['b', 'd', 'c'])
    const fourth = await store.list(list_params({ pageSize: 3, pageToken: third.nextPageToken }), ann)
    expect(ids(fourth.tasks)).toEqual(['a'])
    expect(fourth.nextPageToken).toBe('')
  })

  it('leaves artifacts out unless the request asks for them', async () => {
    const store = await seeded()
    const without = await store.list(list_params({ pageSize: 1 }), ann)
    expect(without.tasks[0]?.artifacts).toEqual([])
    const explicit = await store.list(list_params({ pageSize: 1, includeArtifacts: false }), ann)
    expect(explicit.tasks[0]?.artifacts).toEqual([])
    const included = await store.list(list_params({ pageSize: 1, includeArtifacts: true }), ann)
    expect(included.tasks[0]?.artifacts).toEqual(task('b').artifacts)
  })

  it('refuses a page token it did not write, as a malformed request', async () => {
    const store = await seeded()
    const token = Buffer.from('no separator here').toString('base64')
    await expect(store.list(list_params({ pageToken: token }), ann)).rejects.toMatchObject({
      name: 'RequestMalformedError',
      message: 'Invalid page token format.',
    })
  })

  it('reads a cursor whose id holds the separator', async () => {
    const store = open_store()
    await store.save(task('a|b', { at: '2026-01-01T00:00:02.000Z' }), ann)
    await store.save(task('a', { at: '2026-01-01T00:00:01.000Z' }), ann)
    const first = await store.list(list_params({ pageSize: 1 }), ann)
    expect(ids(first.tasks)).toEqual(['a|b'])
    const second = await store.list(list_params({ pageSize: 1, pageToken: first.nextPageToken }), ann)
    expect(ids(second.tasks)).toEqual(['a'])
  })
})

describe('sqlite_task_store close', () => {
  it('refuses any call once it is closed', async () => {
    const store = sqlite_task_store({ path: ':memory:' })
    store.close()
    await expect(store.load('t1', ann)).rejects.toThrow()
  })
})
