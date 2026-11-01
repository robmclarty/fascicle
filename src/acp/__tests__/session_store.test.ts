import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
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
