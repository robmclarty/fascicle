import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Tool } from '#engine'
import { to_json_schema, validate_schema } from '#schema'
import { resolve_roots } from '../tools/containment.js'
import { apply_change, write_file_change } from '../tools/write_file.js'
import type { AcpSession } from '../types.js'
import { workspace_tools } from '../workspace_tools.js'

/**
 * The fixture, under one scratch directory:
 *
 *   project/           the workspace, reached as `via`, a symlink, so the
 *                      client's terms and the real paths differ
 *     src/a.ts
 *     escape -> outside            escape_file.ts -> outside/secret.ts
 *     inner -> project/src
 *   via -> project
 *   shared/            an additional directory
 *   outside/secret.ts  outside/source.txt, outside every root
 *
 * Each test writes under names of its own, so the writes don't meet.
 */
let base: string
let real_base: string
let real_project: string
let cwd: string
let shared: string
let session: AcpSession

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'fascicle-acp-write-'))
  const project = join(base, 'project')
  await Promise.all(
    [join(project, 'src'), join(base, 'shared'), join(base, 'outside')].map((dir) => mkdir(dir, { recursive: true })),
  )
  await Promise.all([
    writeFile(join(project, 'src', 'a.ts'), 'export const a = 1\n'),
    writeFile(join(base, 'outside', 'secret.ts'), 'secret\n'),
    writeFile(join(base, 'outside', 'source.txt'), 'source\n'),
  ])
  await Promise.all([
    symlink(project, join(base, 'via')),
    symlink(join(base, 'outside'), join(project, 'escape')),
    symlink(join(base, 'outside', 'secret.ts'), join(project, 'escape_file.ts')),
    symlink(join(project, 'src'), join(project, 'inner')),
  ])
  real_base = await realpath(base)
  real_project = join(real_base, 'project')
  cwd = join(base, 'via')
  shared = join(base, 'shared')
  session = {
    id: 'session-1',
    cwd,
    additional_directories: [shared],
    roots: await resolve_roots([cwd, shared]),
    client_capabilities: {},
    mode: () => 'manual',
    approve: () => false,
  }
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

/** The workspace tools' `write_file`. */
function write_file(): Tool {
  const found = workspace_tools(session).find((tool) => tool.name === 'write_file')
  if (found === undefined) throw new Error('workspace_tools has no write_file')
  return found
}

/** Run `write_file`'s `execute` the way the tool loop would after validating its input. */
async function call(input: unknown, abort: AbortSignal = new AbortController().signal): Promise<unknown> {
  return write_file().execute(input, { abort, tool_call_id: 'call_1', step_index: 0 })
}

/** A file in the project, written for one test, returning the name the model would pass. */
async function project_file(name: string, content: string | Uint8Array): Promise<string> {
  await writeFile(join(real_project, name), content)
  return name
}

/** A file's text, read by its real path. */
async function text_of(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

describe('write_file', () => {
  it('describes itself to the model, and declares its input as JSON Schema', async () => {
    const tool = write_file()
    expect(tool.description).toBe(
      'Write a text file in the workspace: create it, along with any directories it needs, or replace everything it holds. ' +
        "content is the file's whole text; to change part of a file, use edit_file. " +
        'The path is absolute or relative to the workspace root.',
    )
    expect(to_json_schema(tool.input_schema)).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to write, absolute or relative to the workspace root' },
        content: { type: 'string', description: "The file's whole text" },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    })
    expect((await validate_schema(tool.input_schema, { path: 'a.md', content: '' })).ok).toBe(true)
    expect((await validate_schema(tool.input_schema, { path: 'a.md' })).ok).toBe(false)
  })

  it('creates a file, working out its change first with old_text null', async () => {
    const input = { path: 'created.md', content: 'hello\n' }
    await expect(write_file_change(session, input)).resolves.toEqual({
      path: join(cwd, 'created.md'),
      real: join(real_project, 'created.md'),
      old_text: null,
      new_text: 'hello\n',
    })
    expect(existsSync(join(real_project, 'created.md'))).toBe(false)
    await expect(call(input)).resolves.toBe('created created.md')
    await expect(text_of(join(real_project, 'created.md'))).resolves.toBe('hello\n')
  })

  it('creates the directories a new file needs, inside the root', async () => {
    await expect(call({ path: 'made/deeper/thing.ts', content: 'x\n' })).resolves.toBe(
      `created ${join('made', 'deeper', 'thing.ts')}`,
    )
    await expect(text_of(join(real_project, 'made', 'deeper', 'thing.ts'))).resolves.toBe('x\n')
  })

  it('overwrites a file, working out its change first with the text it replaces as old_text', async () => {
    const path = await project_file('old.md', 'before\n')
    const input = { path, content: 'after\n' }
    await expect(write_file_change(session, input)).resolves.toEqual({
      path: join(cwd, 'old.md'),
      real: join(real_project, 'old.md'),
      old_text: 'before\n',
      new_text: 'after\n',
    })
    await expect(text_of(join(real_project, 'old.md'))).resolves.toBe('before\n')
    await expect(call(input)).resolves.toBe('overwrote old.md')
    await expect(text_of(join(real_project, 'old.md'))).resolves.toBe('after\n')
  })

  it('writes through a symlink that stays inside to where it lands, naming the file in the client terms', async () => {
    const input = { path: 'inner/linked.ts', content: 'y\n' }
    await expect(write_file_change(session, input)).resolves.toMatchObject({
      path: join(cwd, 'inner', 'linked.ts'),
      real: join(real_project, 'src', 'linked.ts'),
    })
    await expect(call(input)).resolves.toBe(`created ${join('inner', 'linked.ts')}`)
    await expect(text_of(join(real_project, 'src', 'linked.ts'))).resolves.toBe('y\n')
  })

  it('writes a file in an additional directory, shown by its absolute path', async () => {
    const path = join(shared, 'notes', 'n.md')
    await expect(call({ path, content: 'n\n' })).resolves.toBe(`created ${path}`)
    await expect(text_of(join(real_base, 'shared', 'notes', 'n.md'))).resolves.toBe('n\n')
  })

  it.each([
    ['a new file under a symlinked directory that escapes', 'escape/new.ts', 'new.ts'],
    ['a new parent under a symlinked directory that escapes', 'escape/newdir/deeper/new.ts', 'newdir'],
    ['a new parent outside every root', '../outside/climbed/x.ts', 'climbed'],
  ])('refuses %s, creating nothing outside', async (_, path, created) => {
    await expect(call({ path, content: 'z\n' })).rejects.toThrow(
      `${path} is outside the workspace; the file tools only reach paths under ${cwd}, ${shared}`,
    )
    expect(existsSync(join(real_base, 'outside', created))).toBe(false)
  })

  it('refuses a symlink to a file outside, leaving that file as it was', async () => {
    await expect(call({ path: 'escape_file.ts', content: 'overwritten\n' })).rejects.toThrow(
      `escape_file.ts is outside the workspace; the file tools only reach paths under ${cwd}, ${shared}`,
    )
    await expect(text_of(join(real_base, 'outside', 'secret.ts'))).resolves.toBe('secret\n')
  })

  it('refuses a directory, pointing at a file inside it', async () => {
    await expect(call({ path: 'src', content: '' })).rejects.toThrow(
      'src is a directory; write_file changes a file, so name one inside it',
    )
  })

  it('passes any failure but a missing file through, rather than taking it for a new file', async () => {
    await expect(call({ path: 'src/a.ts/x.ts', content: 'x\n' })).rejects.toThrow(/^ENOTDIR: not a directory, stat /)
  })

  it("refuses what isn't a regular file without opening it", async () => {
    execFileSync('mkfifo', [join(real_project, 'pipe')])
    await expect(call({ path: 'pipe', content: '' })).rejects.toThrow("pipe isn't a regular file, so write_file can't change it")
  })

  it('refuses a file with other hard links, leaving the file as it was under every name', async () => {
    await link(join(real_base, 'outside', 'source.txt'), join(real_project, 'hard.txt'))
    await expect(call({ path: 'hard.txt', content: 'changed\n' })).rejects.toThrow(
      "hard.txt is one of 2 hard links to the same file, and the rest may lie outside the workspace, so write_file won't change it",
    )
    await expect(text_of(join(real_base, 'outside', 'source.txt'))).resolves.toBe('source\n')
  })

  it('refuses a file one byte over the change limit from its size, before reading it, and replaces one at the limit', async () => {
    // NUL bytes throughout, so a refusal that came from reading the file would call it binary.
    const over = await project_file('over.bin', Buffer.alloc(1_000_001))
    await expect(call({ path: over, content: 'small\n' })).rejects.toThrow(
      'over.bin is 1000001 bytes, over the 1000000 that write_file and edit_file read to show a change as a diff; change it with run_command instead',
    )
    await expect(readFile(join(real_project, over))).resolves.toHaveLength(1_000_001)
    const at = await project_file('at.txt', 'a'.repeat(1_000_000))
    await expect(call({ path: at, content: 'small\n' })).resolves.toBe('overwrote at.txt')
    await expect(text_of(join(real_project, at))).resolves.toBe('small\n')
  })

  it('refuses to replace a binary file', async () => {
    const path = await project_file('blob.bin', Buffer.from([1, 0, 2]))
    await expect(call({ path, content: 'text\n' })).rejects.toThrow(
      "blob.bin is a binary file (it has a NUL byte in its first 8 KB), so write_file won't change it",
    )
  })

  it("refuses to replace a file that isn't UTF-8 text", async () => {
    const path = await project_file('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    await expect(call({ path, content: 'café\n' })).rejects.toThrow("latin1.txt isn't UTF-8 text, so write_file won't change it")
  })

  it('stops a create when a file appears at its path after the change was worked out', async () => {
    const change = await write_file_change(session, { path: 'raced.md', content: 'mine\n' })
    await writeFile(join(real_project, 'raced.md'), 'theirs\n')
    await expect(apply_change(change, new AbortController().signal)).rejects.toThrow(/^EEXIST/)
    await expect(text_of(join(real_project, 'raced.md'))).resolves.toBe('theirs\n')
  })

  it('stops a create when a symlink appears at its path after the change was worked out, writing nothing through it', async () => {
    const change = await write_file_change(session, { path: 'planted.md', content: 'mine\n' })
    await symlink(join(real_base, 'outside', 'planted.md'), join(real_project, 'planted.md'))
    await expect(apply_change(change, new AbortController().signal)).rejects.toThrow(/^EEXIST/)
    expect(existsSync(join(real_base, 'outside', 'planted.md'))).toBe(false)
  })

  it('writes nothing when the turn is cancelled before the write', async () => {
    const cancel = new AbortController()
    cancel.abort(new Error('the turn was cancelled'))
    await expect(call({ path: 'cancelled/c.md', content: 'c\n' }, cancel.signal)).rejects.toThrow('the turn was cancelled')
    expect(existsSync(join(real_project, 'cancelled'))).toBe(false)
  })

  it('closes the file after reading what it would replace, a refused one included', async () => {
    const text = await project_file('fd.md', 'x\n')
    const binary = await project_file('fd.bin', Buffer.from([0]))
    const latin = await project_file('fd.txt', Buffer.from([0xe9]))
    const open_files = (): number => readdirSync('/dev/fd').length
    const before = open_files()
    for (const content of ['a', 'b', 'c']) {
      await write_file_change(session, { path: text, content })
      await expect(write_file_change(session, { path: binary, content })).rejects.toThrow(/binary file/)
      await expect(write_file_change(session, { path: latin, content })).rejects.toThrow(/UTF-8/)
    }
    expect(open_files()).toBe(before)
  })

  it.each([
    ['no path', { content: 'x' }],
    ['no content', { path: 'x.md' }],
    ['content that is not a string', { path: 'x.md', content: 3 }],
    ['input that is not an object', 'x.md'],
  ])('refuses %s', async (_, input) => {
    await expect(call(input)).rejects.toThrow('write_file needs a path and the content to write, as strings')
  })
})
