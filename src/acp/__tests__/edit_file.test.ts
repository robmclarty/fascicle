import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Tool } from '#engine'
import { to_json_schema, validate_schema } from '#schema'
import { resolve_roots } from '../tools/containment.js'
import { edit_file_change } from '../tools/edit_file.js'
import type { AcpMode, AcpSession } from '../types.js'
import { workspace_tools } from '../workspace_tools.js'

/**
 * The fixture, under one scratch directory:
 *
 *   project/           the workspace, reached as `via`, a symlink, so the
 *                      client's terms and the real paths differ
 *     escape_file.ts -> outside/secret.ts
 *     .git/config                  node_modules/.bin/tsc
 *     vendor/lib/.git/config       a nested repository
 *     worktree/.git                a worktree's .git, which is a file
 *     git_config -> .git/config
 *     gitlink/.git -> gitstore     a .git that's a symlink, to gitstore/config
 *   via -> project
 *   outside/secret.ts  outside every root
 *
 * Each test edits a file of its own, so the edits don't meet.
 */
/** What every file under a `.git` or a `node_modules` holds, which no refused edit may change. */
const GUARDED_TEXT = 'x = 1\n'

let base: string
let real_project: string
let real_secret: string
let cwd: string
let session: AcpSession

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'fascicle-acp-edit-'))
  const project = join(base, 'project')
  const guarded = ['.git/config', 'node_modules/.bin/tsc', 'vendor/lib/.git/config', 'worktree/.git', 'gitstore/config']
  await Promise.all(
    [project, join(base, 'outside'), ...guarded.map((path) => dirname(join(project, path)))].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  )
  await Promise.all([
    writeFile(join(base, 'outside', 'secret.ts'), 'const secret = 1\n'),
    ...guarded.map((path) => writeFile(join(project, path), GUARDED_TEXT)),
    mkdir(join(project, 'gitlink')),
  ])
  await Promise.all([
    symlink(project, join(base, 'via')),
    symlink(join(base, 'outside', 'secret.ts'), join(project, 'escape_file.ts')),
    symlink(join(project, '.git', 'config'), join(project, 'git_config')),
    symlink(join(project, 'gitstore'), join(project, 'gitlink', '.git')),
  ])
  real_project = join(await realpath(base), 'project')
  real_secret = join(await realpath(base), 'outside', 'secret.ts')
  cwd = join(base, 'via')
  session = {
    id: 'session-1',
    cwd,
    additional_directories: [],
    roots: await resolve_roots([cwd]),
    client_capabilities: {},
    mode: () => 'manual',
    approve: () => false,
  }
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

/** The workspace tools' `edit_file`. */
function edit_file(): Tool {
  const found = workspace_tools(session).find((tool) => tool.name === 'edit_file')
  if (found === undefined) throw new Error('workspace_tools has no edit_file')
  return found
}

/** Run `edit_file`'s `execute` the way the tool loop would after validating its input. */
async function call(input: unknown, abort: AbortSignal = new AbortController().signal): Promise<unknown> {
  return edit_file().execute(input, { abort, tool_call_id: 'call_1', step_index: 0 })
}

/** A file in the project, written for one test, returning the name the model would pass. */
async function project_file(name: string, content: string | Uint8Array): Promise<string> {
  await writeFile(join(real_project, name), content)
  return name
}

/** A project file's text, read by its real path. */
async function text_of(name: string): Promise<string> {
  return readFile(join(real_project, name), 'utf8')
}

describe('edit_file', () => {
  it('describes itself to the model, and declares its input as JSON Schema', async () => {
    const tool = edit_file()
    expect(tool.description).toBe(
      'Edit a text file in the workspace by replacing old_text with new_text. ' +
        'old_text has to match the file exactly, whitespace and line breaks included, ' +
        'and appear in it once, unless replace_all is set to replace every match. ' +
        'Copy it from read_file without the line number and tab that read_file puts before each line. ' +
        'The path is absolute or relative to the workspace root.',
    )
    expect(to_json_schema(tool.input_schema)).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to edit, absolute or relative to the workspace root' },
        old_text: { type: 'string', minLength: 1, description: 'The exact text to replace' },
        new_text: { type: 'string', description: 'The text to put in its place' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every match of old_text, rather than exactly one; default: false',
        },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    })
    expect((await validate_schema(tool.input_schema, { path: 'a', old_text: 'b', new_text: 'c' })).ok).toBe(true)
    expect((await validate_schema(tool.input_schema, { path: 'a', old_text: 'b' })).ok).toBe(false)
    expect((await validate_schema(tool.input_schema, { path: 'a', old_text: 'b', new_text: 'c', replace_all: 'yes' })).ok).toBe(
      false,
    )
  })

  it('replaces the one exact match, working out the whole file before and after and the line where it starts', async () => {
    const path = await project_file('one.ts', 'const a = 1\nconst b = 2\nconst c = 3\n')
    const input = { path, old_text: 'b = 2', new_text: 'b = 20' }
    await expect(edit_file_change(session, input)).resolves.toEqual({
      path: join(cwd, 'one.ts'),
      real: join(real_project, 'one.ts'),
      old_text: 'const a = 1\nconst b = 2\nconst c = 3\n',
      new_text: 'const a = 1\nconst b = 20\nconst c = 3\n',
      line: 2,
      matches: 1,
    })
    await expect(text_of(path)).resolves.toBe('const a = 1\nconst b = 2\nconst c = 3\n')
    await expect(call(input)).resolves.toBe('edited one.ts at line 2')
    await expect(text_of(path)).resolves.toBe('const a = 1\nconst b = 20\nconst c = 3\n')
  })

  it.each([
    ['at the top of the file', 'const a', 1],
    ['across lines, from the line where it starts', '2\nconst c', 2],
    ['on the last line', 'c = 3', 3],
  ])('finds the line of a match %s', async (_, old_text, line) => {
    const path = await project_file(`line-${line}.ts`, 'const a = 1\nconst b = 2\nconst c = 3\n')
    await expect(edit_file_change(session, { path, old_text, new_text: 'x' })).resolves.toMatchObject({ line })
  })

  it("fails when old_text isn't in the file, leaving the file as it was", async () => {
    const path = await project_file('missing.ts', 'const a = 1\n')
    await expect(call({ path, old_text: 'const  a', new_text: 'const b' })).rejects.toThrow(
      "old_text doesn't appear in missing.ts; it has to match the file exactly, whitespace included, so read the lines again and copy them without their numbers",
    )
    await expect(text_of(path)).resolves.toBe('const a = 1\n')
  })

  it('fails when old_text appears more than once without replace_all, saying how often, and leaves the file as it was', async () => {
    const path = await project_file('twice.ts', 'foo()\nfoo()\nfoo()\n')
    const refusal =
      'old_text appears 3 times in twice.ts; include more of the lines around it so it matches once, or set replace_all to replace every one'
    await expect(call({ path, old_text: 'foo()', new_text: 'bar()' })).rejects.toThrow(refusal)
    await expect(call({ path, old_text: 'foo()', new_text: 'bar()', replace_all: false })).rejects.toThrow(refusal)
    await expect(text_of(path)).resolves.toBe('foo()\nfoo()\nfoo()\n')
  })

  it('replaces every match with replace_all, from the line of the first', async () => {
    const path = await project_file('many.ts', 'x\nfoo\nfoo bar\nbaz foo\n')
    const input = { path, old_text: 'foo', new_text: 'qux', replace_all: true }
    await expect(edit_file_change(session, input)).resolves.toMatchObject({
      new_text: 'x\nqux\nqux bar\nbaz qux\n',
      line: 2,
      matches: 3,
    })
    await expect(call(input)).resolves.toBe('edited many.ts in 3 places, the first at line 2')
    await expect(text_of(path)).resolves.toBe('x\nqux\nqux bar\nbaz qux\n')
  })

  it('reports a replace_all that found one match the way a single edit reads', async () => {
    const path = await project_file('single.ts', 'a\nb\n')
    await expect(call({ path, old_text: 'b', new_text: 'c', replace_all: true })).resolves.toBe('edited single.ts at line 2')
  })

  it('puts new_text in as written, $& and $1 included', async () => {
    const path = await project_file('dollars.ts', 'price: X\n')
    await expect(call({ path, old_text: 'X', new_text: "$&$1$$$'" })).resolves.toBe('edited dollars.ts at line 1')
    await expect(text_of(path)).resolves.toBe("price: $&$1$$$'\n")
  })

  it('keeps the rest of the file byte for byte, a byte order mark and CRLF line endings included', async () => {
    const path = await project_file('crlf.txt', '﻿one\r\ntwo\r\nthree\r\n')
    await expect(call({ path, old_text: 'two', new_text: '2' })).resolves.toBe('edited crlf.txt at line 2')
    await expect(readFile(join(real_project, path))).resolves.toEqual(Buffer.from('﻿one\r\n2\r\nthree\r\n'))
  })

  it("fails on a file that doesn't exist, pointing at write_file", async () => {
    await expect(call({ path: 'nope.ts', old_text: 'a', new_text: 'b' })).rejects.toThrow(
      "nope.ts doesn't exist; write_file creates a file",
    )
  })

  it('refuses a symlink to a file outside, leaving that file as it was', async () => {
    await expect(call({ path: 'escape_file.ts', old_text: 'secret', new_text: 'leaked' })).rejects.toThrow(
      `escape_file.ts is outside the workspace; the file tools only reach paths under ${cwd}`,
    )
    await expect(readFile(real_secret, 'utf8')).resolves.toBe('const secret = 1\n')
  })

  it("refuses a missing file outside as outside, before saying it doesn't exist", async () => {
    await expect(call({ path: '../outside/nothing.ts', old_text: 'a', new_text: 'b' })).rejects.toThrow(
      `../outside/nothing.ts is outside the workspace; the file tools only reach paths under ${cwd}`,
    )
  })

  it('refuses a file one byte over the change limit, and edits one at the limit', async () => {
    const over = await project_file('over.txt', `x\n${'a'.repeat(999_999)}`)
    await expect(call({ path: over, old_text: 'x', new_text: 'y' })).rejects.toThrow(
      'over.txt is 1000001 bytes, over the 1000000 that write_file and edit_file read to show a change as a diff; change it with run_command instead',
    )
    await expect(readFile(join(real_project, over))).resolves.toHaveLength(1_000_001)
    const at = await project_file('at.txt', `x\n${'a'.repeat(999_998)}`)
    await expect(call({ path: at, old_text: 'x', new_text: 'y' })).resolves.toBe('edited at.txt at line 1')
    await expect(text_of(at)).resolves.toBe(`y\n${'a'.repeat(999_998)}`)
  })

  it('refuses a binary file, naming edit_file', async () => {
    const path = await project_file('blob.bin', Buffer.from([0x61, 0, 0x62]))
    await expect(call({ path, old_text: 'a', new_text: 'c' })).rejects.toThrow(
      "blob.bin is a binary file (it has a NUL byte in its first 8 KB), so edit_file won't change it",
    )
  })

  it("refuses a file that isn't UTF-8 text, since rewriting it would change bytes outside the edit", async () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x0a])
    const path = await project_file('latin1.txt', latin1)
    await expect(call({ path, old_text: 'x', new_text: 'y' })).rejects.toThrow(
      "latin1.txt isn't UTF-8 text, so edit_file won't change it",
    )
    await expect(readFile(join(real_project, path))).resolves.toEqual(latin1)
  })

  it('refuses an empty old_text, which would match everywhere', async () => {
    const path = await project_file('empty-old.ts', 'a\n')
    await expect(call({ path, old_text: '', new_text: 'b' })).rejects.toThrow(
      "old_text is empty, so there's nothing to find; write_file writes a whole file",
    )
  })

  it('refuses an edit whose old_text and new_text are the same', async () => {
    const path = await project_file('same.ts', 'a\n')
    await expect(call({ path, old_text: 'a', new_text: 'a' })).rejects.toThrow(
      'old_text and new_text are the same, so the edit would change nothing',
    )
  })

  it('writes nothing when the turn is cancelled before the write', async () => {
    const path = await project_file('cancelled.ts', 'a\n')
    const cancel = new AbortController()
    cancel.abort(new Error('the turn was cancelled'))
    await expect(call({ path, old_text: 'a', new_text: 'b' }, cancel.signal)).rejects.toThrow('the turn was cancelled')
    await expect(text_of(path)).resolves.toBe('a\n')
  })

  it.each([
    ['no path', { old_text: 'a', new_text: 'b' }],
    ['an old_text that is not a string', { path: 'x.ts', old_text: 1, new_text: 'b' }],
    ['no new_text', { path: 'x.ts', old_text: 'a' }],
    ['a replace_all that is not true or false', { path: 'x.ts', old_text: 'a', new_text: 'b', replace_all: 'yes' }],
    ['input that is not an object', 'x.ts'],
  ])('refuses %s', async (_, input) => {
    await expect(call(input)).rejects.toThrow(
      'edit_file needs path, old_text, and new_text as strings, and takes replace_all as true or false',
    )
  })
})

/** The refusal an edit into `.git` or `node_modules` fails with. */
function floor(path: string, segment: string): string {
  return `${path} reaches ${segment}, where edit_file never writes, since what's there can run on the user's next command without showing in git diff; if it has to change, use run_command`
}

describe('edit_file: .git and node_modules', () => {
  it.each([
    ["the project's git config", '.git/config', '.git', '.git/config'],
    ['a binary a package manager runs', 'node_modules/.bin/tsc', 'node_modules', 'node_modules/.bin/tsc'],
    ["a nested repository's .git", 'vendor/lib/.git/config', '.git', 'vendor/lib/.git/config'],
    ["a worktree's .git file", 'worktree/.git', '.git', 'worktree/.git'],
    ['a symlink to a file in .git', 'git_config', '.git', '.git/config'],
    ['a .git that is a symlink to an ordinary directory', 'gitlink/.git/config', '.git', 'gitstore/config'],
    ['.git in capitals', '.GIT/config', '.git', '.git/config'],
  ])('refuses %s, naming the segment and changing nothing', async (_, path, segment, lands) => {
    const input = { path, old_text: 'x = 1', new_text: 'x = 2' }
    await expect(edit_file_change(session, input)).rejects.toThrow(floor(path, segment))
    await expect(call(input)).rejects.toThrow(floor(path, segment))
    await expect(text_of(lands)).resolves.toBe(GUARDED_TEXT)
  })

  it("refuses a missing file in .git as the floor, before saying it doesn't exist", async () => {
    await expect(call({ path: '.git/hooks/pre-commit', old_text: 'a', new_text: 'b' })).rejects.toThrow(
      floor('.git/hooks/pre-commit', '.git'),
    )
  })

  it.each<AcpMode>(['manual', 'accept_edits', 'auto'])('refuses in %s, whether or not the mode asks first', async (mode) => {
    const tool = workspace_tools({ ...session, mode: () => mode }).find((found) => found.name === 'edit_file')
    expect(typeof tool?.needs_approval === 'function' && (await tool.needs_approval({}))).toBe(mode === 'manual')
    const input = { path: '.git/config', old_text: 'x = 1', new_text: 'x = 2' }
    await expect(
      tool?.execute(input, { abort: new AbortController().signal, tool_call_id: 'call_1', step_index: 0 }),
    ).rejects.toThrow(floor('.git/config', '.git'))
    await expect(text_of('.git/config')).resolves.toBe(GUARDED_TEXT)
  })
})
