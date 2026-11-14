import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { filesystem_session_store } from '../session_store.js'
import type { AcpStoredSession } from '../types.js'

const scratch_dirs: string[] = []

/** A fresh directory under the system's temp directory, removed after the suite. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-sessions-'))
  scratch_dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await Promise.all(scratch_dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function stored(overrides: Partial<AcpStoredSession> = {}): AcpStoredSession {
  return {
    id: 'session-1',
    cwd: '/work',
    additional_directories: ['/lib'],
    mode: 'accept_edits',
    title: 'Fix the test',
    updated_at: '2026-10-31T12:00:00.000Z',
    history: [
      { role: 'user', text: 'fix it' },
      { role: 'agent', text: 'fixed', cancelled: true },
    ],
    usage: { context_tokens: 1200, cost_usd: 0.02, priced: true },
    ...overrides,
  }
}

describe('filesystem_session_store', () => {
  it('loads a saved session as it was saved, and a later save replaces it', async () => {
    const store = filesystem_session_store({ root_dir: join(await scratch(), 'made-on-save') })
    await store.save(stored())
    expect(await store.load('session-1')).toEqual(stored())
    await store.save(stored({ title: 'Renamed' }))
    expect(await store.load('session-1')).toEqual(stored({ title: 'Renamed' }))
  })

  it.skipIf(process.platform === 'win32')('makes its directory and its files readable by their owner alone', async () => {
    const root_dir = join(await scratch(), 'private')
    await filesystem_session_store({ root_dir }).save(stored())
    expect((await stat(root_dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(root_dir, 'session-1.json'))).mode & 0o777).toBe(0o600)
  })

  it('leaves no temporary file behind', async () => {
    const root_dir = await scratch()
    await filesystem_session_store({ root_dir }).save(stored())
    expect(await readdir(root_dir)).toEqual(['session-1.json'])
  })

  it('reads an id it holds no file for, or one that could name another path, as no session', async () => {
    const root_dir = await scratch()
    await writeFile(join(root_dir, 'outside.json'), JSON.stringify(stored()))
    const store = filesystem_session_store({ root_dir: join(root_dir, 'sessions') })
    expect(await store.load('missing')).toBeUndefined()
    expect(await store.load('../outside')).toBeUndefined()
  })

  it('refuses to save a session whose id could name another path', async () => {
    const store = filesystem_session_store({ root_dir: await scratch() })
    await expect(store.save(stored({ id: '../escape' }))).rejects.toThrow(
      `can't save session "../escape": an id names a file, so use letters, digits, - and _`,
    )
  })

  it('fails a load naming a file that is not a stored session', async () => {
    const root_dir = await scratch()
    await writeFile(join(root_dir, 'broken.json'), '{ not json')
    await writeFile(join(root_dir, 'wrong.json'), JSON.stringify({ ...stored(), mode: 'yolo' }))
    const store = filesystem_session_store({ root_dir })
    const message = (name: string) =>
      `${join(root_dir, name)} isn't a stored ACP session; fix or delete the file to load the others`
    await expect(store.load('broken')).rejects.toThrow(message('broken.json'))
    await expect(store.load('wrong')).rejects.toThrow(message('wrong.json'))
  })

  it.each<[string, Record<string, unknown> | unknown[]]>([
    ['a history entry with an unknown role', { history: [{ role: 'system', text: 'x' }] }],
    ['a history entry marked cancelled with anything but true', { history: [{ role: 'user', text: 'x', cancelled: false }] }],
    ['a history that is not a list', { history: 'fix it' }],
    ['usage with a missing field', { usage: { context_tokens: 1, cost_usd: 0 } }],
    ['a title that is not a string', { title: 3 }],
    ['a count of turns that is not a number', { turns: 'two' }],
    ['additional directories that are not strings', { additional_directories: [1] }],
    ['a list in place of the session', []],
  ])('refuses %s', async (_, fields) => {
    const root_dir = await scratch()
    const value = Array.isArray(fields) ? fields : { ...stored(), ...fields }
    await writeFile(join(root_dir, 'odd.json'), JSON.stringify(value))
    await expect(filesystem_session_store({ root_dir }).load('odd')).rejects.toThrow("isn't a stored ACP session")
  })

  it('loads an untitled session', async () => {
    const store = filesystem_session_store({ root_dir: await scratch() })
    await store.save(stored({ title: null }))
    expect(await store.load('session-1')).toMatchObject({ title: null })
  })

  it('lists every stored session without its history, skipping a bad file with a warning', async () => {
    const root_dir = await scratch()
    const store = filesystem_session_store({ root_dir })
    await store.save(stored())
    await store.save(stored({ id: 'session-2', title: null, additional_directories: [] }))
    await writeFile(join(root_dir, 'broken.json'), 'nope')
    await writeFile(join(root_dir, 'notes.txt'), 'not a session')
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const listed = await store.list()
    expect(listed.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'session-1', cwd: '/work', additional_directories: ['/lib'], title: 'Fix the test', updated_at: '2026-10-31T12:00:00.000Z' },
      { id: 'session-2', cwd: '/work', additional_directories: [], title: null, updated_at: '2026-10-31T12:00:00.000Z' },
    ])
    expect(stderr).toHaveBeenCalledWith(
      `fascicle/acp: ${join(root_dir, 'broken.json')} isn't a stored ACP session; fix or delete the file to load the others\n`,
    )
  })

  it('lists nothing before the first save', async () => {
    const store = filesystem_session_store({ root_dir: join(await scratch(), 'never-made') })
    expect(await store.list()).toEqual([])
  })

  it('surfaces a failure to read the directory that is not a missing one', async () => {
    const root_dir = join(await scratch(), 'a-file')
    await writeFile(root_dir, 'not a directory')
    await expect(filesystem_session_store({ root_dir }).list()).rejects.toThrow('ENOTDIR')
  })
})

const turn: SessionUpdate[] = [
  { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fix it' } },
  { sessionUpdate: 'tool_call', toolCallId: 'card-1', title: 'Edit a.ts', status: 'completed' },
]
const reply: SessionUpdate[] = [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }]

describe('filesystem_session_store: turns', () => {
  it('keeps each turn in a file of its own beside the session, and loads the first count of them in order', async () => {
    const root_dir = await scratch()
    const store = filesystem_session_store({ root_dir })
    await store.save_turn('session-1', 1, reply)
    await store.save_turn('session-1', 0, turn)
    expect((await readdir(join(root_dir, 'session-1.turns'))).toSorted()).toEqual(['0.json', '1.json'])
    expect(await store.load_turns('session-1', 2)).toEqual([turn, reply])
    expect(await store.load_turns('session-1', 1)).toEqual([turn])
    expect(await store.load_turns('session-1', 0)).toEqual([])
  })

  it('loads a session that counts its turns, and lists it beside its turns directory', async () => {
    const store = filesystem_session_store({ root_dir: await scratch() })
    await store.save_turn('session-1', 0, turn)
    await store.save(stored({ turns: 1 }))
    expect(await store.load('session-1')).toEqual(stored({ turns: 1 }))
    expect((await store.list()).map((entry) => entry.id)).toEqual(['session-1'])
  })

  it.skipIf(process.platform === 'win32')('makes the turns directory and each turn readable by their owner alone', async () => {
    const root_dir = join(await scratch(), 'private')
    await filesystem_session_store({ root_dir }).save_turn('session-1', 0, turn)
    expect((await stat(join(root_dir, 'session-1.turns'))).mode & 0o777).toBe(0o700)
    expect((await stat(join(root_dir, 'session-1.turns', '0.json'))).mode & 0o777).toBe(0o600)
    expect(await readdir(join(root_dir, 'session-1.turns'))).toEqual(['0.json'])
  })

  it('leaves out a turn whose file is missing, broken, or not a list of updates', async () => {
    const root_dir = await scratch()
    const store = filesystem_session_store({ root_dir })
    await store.save_turn('session-1', 0, turn)
    await store.save_turn('session-1', 3, reply)
    await writeFile(join(root_dir, 'session-1.turns', '1.json'), '{ not json')
    await writeFile(join(root_dir, 'session-1.turns', '2.json'), JSON.stringify([{ not: 'an update' }]))
    expect(await store.load_turns('session-1', 5)).toEqual([turn, reply])
  })

  it('refuses to keep a turn for an id that could name another path, and loads none for one', async () => {
    const store = filesystem_session_store({ root_dir: await scratch() })
    await expect(store.save_turn('../escape', 0, turn)).rejects.toThrow(
      `can't save session "../escape": an id names a file, so use letters, digits, - and _`,
    )
    expect(await store.load_turns('../escape', 1)).toEqual([])
  })
})

describe('filesystem_session_store: delete', () => {
  it('removes a session and its turns, and leaves the others', async () => {
    const root_dir = await scratch()
    const store = filesystem_session_store({ root_dir })
    await store.save_turn('session-1', 0, turn)
    await store.save(stored({ turns: 1 }))
    await store.save(stored({ id: 'session-2' }))
    await store.delete('session-1')
    expect(await readdir(root_dir)).toEqual(['session-2.json'])
    expect(await store.load('session-1')).toBeUndefined()
  })

  it('resolves for a session it does not hold, and touches nothing for an id that could name another path', async () => {
    const root_dir = await scratch()
    await writeFile(join(root_dir, 'outside.json'), JSON.stringify(stored()))
    const store = filesystem_session_store({ root_dir: join(root_dir, 'sessions') })
    await expect(store.delete('missing')).resolves.toBeUndefined()
    await expect(store.delete('../outside')).resolves.toBeUndefined()
    expect(await readdir(root_dir)).toEqual(['outside.json'])
  })
})
