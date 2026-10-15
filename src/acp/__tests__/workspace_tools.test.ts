import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Tool } from '#engine'
import { to_json_schema, validate_schema } from '#schema'
import { contain, resolve_roots, shown_path } from '../tools/containment.js'
import type { AcpSession, WorkspaceToolsOptions } from '../types.js'
import { workspace_tools } from '../workspace_tools.js'

/**
 * The fixture, under one scratch directory:
 *
 *   project/           the workspace, reached as `via`, a symlink, the way
 *                      macOS reaches /tmp; tmpdir() is often behind one too
 *     notes.md  .env.example  src/a.ts  src/deep/b.ts  sub/keep.ts
 *     .git/HEAD  node_modules/pkg/index.js  sub/node_modules/q/q.ts
 *     sub/.git         a file, the way a git worktree has one
 *     escape -> outside            escape_file.ts -> outside/secret.ts
 *     inner -> project/src         dangling_in -> project/src/missing.ts
 *     dangling_out -> outside/missing.ts
 *     hop -> missing/../hop        loop_a -> loop_b -> loop_a
 *   via -> project
 *   shared/doc.md      an additional directory
 *   outside/secret.ts  outside/deep/x.ts
 *   project-evil/f.ts  a sibling whose name starts with the root's
 *   reads/             a second workspace, for read_file's own files
 */
let base: string
let real_project: string
let cwd: string
let shared: string
let reads: string
let session: AcpSession
let reading: AcpSession

/** A session over `cwd` and the additional directories, its roots resolved the way `session/new` does. */
async function session_over(root: string, additional: string[] = []): Promise<AcpSession> {
  return {
    id: 'session-1',
    cwd: root,
    additional_directories: additional,
    roots: await resolve_roots([root, ...additional]),
    client_capabilities: {},
  }
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'fascicle-acp-tools-'))
  const project = join(base, 'project')
  await Promise.all(
    [
      join(project, 'src', 'deep'),
      join(project, '.git'),
      join(project, 'node_modules', 'pkg'),
      join(project, 'sub', 'node_modules', 'q'),
      join(base, 'outside', 'deep'),
      join(base, 'project-evil'),
      join(base, 'shared'),
      join(base, 'reads'),
    ].map((dir) => mkdir(dir, { recursive: true })),
  )
  await Promise.all([
    writeFile(join(project, 'notes.md'), 'one\ntwo\nthree\n'),
    writeFile(join(project, '.env.example'), 'KEY=\n'),
    writeFile(join(project, 'src', 'a.ts'), 'export const a = 1\n'),
    writeFile(join(project, 'src', 'deep', 'b.ts'), 'export const b = 2\n'),
    writeFile(join(project, 'sub', 'keep.ts'), 'keep\n'),
    writeFile(join(project, 'sub', '.git'), 'gitdir: elsewhere\n'),
    writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n'),
    writeFile(join(project, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n'),
    writeFile(join(project, 'sub', 'node_modules', 'q', 'q.ts'), 'q\n'),
    writeFile(join(base, 'outside', 'secret.ts'), 'secret\n'),
    writeFile(join(base, 'outside', 'deep', 'x.ts'), 'x\n'),
    writeFile(join(base, 'project-evil', 'f.ts'), 'evil\n'),
    writeFile(join(base, 'shared', 'doc.md'), 'shared doc\n'),
  ])
  await Promise.all([
    symlink(project, join(base, 'via')),
    symlink(join(base, 'outside'), join(project, 'escape')),
    symlink(join(base, 'outside', 'secret.ts'), join(project, 'escape_file.ts')),
    symlink(join(project, 'src'), join(project, 'inner')),
    symlink(join(project, 'src', 'missing.ts'), join(project, 'dangling_in')),
    symlink(join(base, 'outside', 'missing.ts'), join(project, 'dangling_out')),
    symlink('missing/../hop', join(project, 'hop')),
    symlink('loop_b', join(project, 'loop_a')),
    symlink('loop_a', join(project, 'loop_b')),
  ])
  real_project = join(await realpath(base), 'project')
  cwd = join(base, 'via')
  shared = join(base, 'shared')
  reads = join(base, 'reads')
  session = await session_over(cwd, [shared])
  reading = await session_over(reads)
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

/** Find one tool by name in a session's workspace tools. */
function tool_named(name: string, over: AcpSession, options?: WorkspaceToolsOptions): Tool {
  const found = workspace_tools(over, options).find((tool) => tool.name === name)
  if (found === undefined) throw new Error(`workspace_tools has no ${name}`)
  return found
}

/** Run a workspace tool's `execute` the way the tool loop would after validating its input. */
async function call(
  name: string,
  input: unknown,
  options: { over?: AcpSession; tools?: WorkspaceToolsOptions; abort?: AbortSignal } = {},
): Promise<unknown> {
  const tool = tool_named(name, options.over ?? session, options.tools)
  return tool.execute(input, { abort: options.abort ?? new AbortController().signal, tool_call_id: 'call_1', step_index: 0 })
}

/** A file under `reads`, written for one test, returning the name the model would pass. */
async function read_fixture(name: string, content: string | Uint8Array): Promise<string> {
  await writeFile(join(reads, name), content)
  return name
}

/** The lines `read_file` shows for 1..count, each `line <n>`. */
function shown_lines(from: number, to: number): string {
  return Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(6)}\tline ${from + i}`).join('\n')
}

/** A file of `count` lines, each `line <n>`. */
function lines_text(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join('')
}

describe('workspace_tools', () => {
  it('returns the reads, then the writes, in that order', () => {
    expect(workspace_tools(session).map((tool) => tool.name)).toEqual([
      'read_file',
      'list_files',
      'search',
      'write_file',
      'edit_file',
    ])
  })

  it("describes read_file to the model with its cap, and declares its input as JSON Schema", () => {
    const tool = tool_named('read_file', session, { read_limit_lines: 300 })
    expect(tool.description).toBe(
      'Read a text file in the workspace. Returns its lines numbered from 1, at most 300 per call; ' +
        'pass offset (the first line to read) and limit to read part of a longer file. ' +
        'Lines over 2000 characters are cut. The path is absolute or relative to the workspace root.',
    )
    expect(to_json_schema(tool.input_schema)).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to read, absolute or relative to the workspace root' },
        offset: { type: 'integer', minimum: 1, description: 'The first line to read, counting from 1; default: 1' },
        limit: { type: 'integer', minimum: 1, description: 'How many lines to read; default and most: 300' },
      },
      required: ['path'],
      additionalProperties: false,
    })
  })

  it('describes list_files to the model with the names it skips, and declares its input as JSON Schema', () => {
    const tool = tool_named('list_files', session)
    expect(tool.description).toBe(
      'List the files in the workspace that match a glob pattern, one per line; a path under the workspace root is shown relative to it. ' +
        'The pattern matches under path (default: the workspace root) and defaults to **/*. ' +
        'As in a shell, * and ** skip names that start with a dot, so name the dot to list hidden files (.github/**/*). ' +
        'Skips .git, node_modules.',
    )
    expect(to_json_schema(tool.input_schema)).toEqual({
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'A glob such as src/**/*.ts; default: **/*' },
        path: {
          type: 'string',
          description: 'The directory to search, absolute or relative to the workspace root; default: the root',
        },
      },
      additionalProperties: false,
    })
    expect(tool_named('list_files', session, { ignore: [] }).description).toBe(
      'List the files in the workspace that match a glob pattern, one per line; a path under the workspace root is shown relative to it. ' +
        'The pattern matches under path (default: the workspace root) and defaults to **/*. ' +
        'As in a shell, * and ** skip names that start with a dot, so name the dot to list hidden files (.github/**/*).',
    )
  })

  it('validates input against the schemas the tool loop checks before execute', async () => {
    const read = tool_named('read_file', session)
    expect((await validate_schema(read.input_schema, { path: 'a', offset: 2 })).ok).toBe(true)
    expect((await validate_schema(read.input_schema, { offset: 2 })).ok).toBe(false)
    expect((await validate_schema(read.input_schema, { path: 'a', limit: 1.5 })).ok).toBe(false)
    const list = tool_named('list_files', session)
    expect((await validate_schema(list.input_schema, {})).ok).toBe(true)
    expect((await validate_schema(list.input_schema, { pattern: 3 })).ok).toBe(false)
  })
})

describe('containment', () => {
  it('resolves a relative path against cwd and returns it in the client terms and as a real path', async () => {
    await expect(contain(session, 'src/a.ts')).resolves.toEqual({
      path: join(cwd, 'src', 'a.ts'),
      real: join(real_project, 'src', 'a.ts'),
    })
  })

  it('takes an absolute path in the client terms or as a real path', async () => {
    await expect(contain(session, join(cwd, 'notes.md'))).resolves.toMatchObject({ real: join(real_project, 'notes.md') })
    await expect(contain(session, join(real_project, 'notes.md'))).resolves.toEqual({
      path: join(real_project, 'notes.md'),
      real: join(real_project, 'notes.md'),
    })
  })

  it('allows the root itself', async () => {
    await expect(contain(session, '.')).resolves.toEqual({ path: cwd, real: real_project })
  })

  it('allows a path in an additional directory', async () => {
    const doc = join(shared, 'doc.md')
    await expect(contain(session, doc)).resolves.toEqual({ path: doc, real: join(await realpath(shared), 'doc.md') })
  })

  it('allows a symlink that stays inside, answering with where it lands', async () => {
    await expect(contain(session, 'inner/a.ts')).resolves.toMatchObject({ real: join(real_project, 'src', 'a.ts') })
  })

  it("resolves a path that doesn't exist yet through its nearest existing ancestor", async () => {
    await expect(contain(session, 'src/new/deeper/file.ts')).resolves.toEqual({
      path: join(cwd, 'src', 'new', 'deeper', 'file.ts'),
      real: join(real_project, 'src', 'new', 'deeper', 'file.ts'),
    })
  })

  it('treats a path beneath a file as missing rather than failing', async () => {
    await expect(contain(session, 'notes.md/x')).resolves.toMatchObject({ real: join(real_project, 'notes.md', 'x') })
  })

  it('resolves a dangling symlink through its target', async () => {
    await expect(contain(session, 'dangling_in')).resolves.toMatchObject({ real: join(real_project, 'src', 'missing.ts') })
  })

  it.each([
    ['a relative path that climbs out', '../outside/secret.ts'],
    ['an absolute path outside', 'ABSOLUTE'],
    ['a symlink to a file outside', 'escape_file.ts'],
    ['a path through a symlinked directory outside', 'escape/secret.ts'],
    ['a missing path under a symlinked directory outside', 'escape/deep/new.ts'],
    ['a missing path outside, refused the same as one that exists', '../outside/nothing.ts'],
    ['a dangling symlink whose target is outside', 'dangling_out'],
    ["a sibling whose name starts with the root's", '../project-evil/f.ts'],
  ])('refuses %s, naming the roots as the client sent them', async (_, requested) => {
    const path = requested === 'ABSOLUTE' ? join(base, 'outside', 'secret.ts') : requested
    await expect(contain(session, path)).rejects.toThrow(
      `${path} is outside the workspace; the file tools only reach paths under ${cwd}, ${shared}`,
    )
  })

  it('gives up on a missing path that loops back through its own symlink', async () => {
    await expect(contain(session, 'hop')).rejects.toThrow(/hop passes through too many symbolic links to resolve$/)
  })

  it("passes an error that isn't a missing path straight through", async () => {
    await expect(contain(session, 'loop_a')).rejects.toThrow(/^ELOOP/)
  })

  it('lets a session rooted at / reach any path', async () => {
    const everywhere = await session_over('/')
    await expect(contain(everywhere, join(real_project, 'notes.md'))).resolves.toMatchObject({
      real: join(real_project, 'notes.md'),
    })
  })

  it('resolves roots in order, cwd first', async () => {
    await expect(resolve_roots([cwd, shared])).resolves.toEqual([real_project, await realpath(shared)])
  })

  it('shows a path under cwd relative to it, cwd itself as ., and anything else as it is', () => {
    expect(shown_path(session, join(cwd, 'src', 'a.ts'))).toBe(join('src', 'a.ts'))
    expect(shown_path(session, cwd)).toBe('.')
    expect(shown_path(session, join(shared, 'doc.md'))).toBe(join(shared, 'doc.md'))
  })
})

describe('read_file', () => {
  it('returns the file with its lines numbered', async () => {
    await expect(call('read_file', { path: 'notes.md' })).resolves.toBe('     1\tone\n     2\ttwo\n     3\tthree')
  })

  it('reads the same file by a relative path, an absolute one, or through an inner symlink', async () => {
    const expected = '     1\texport const a = 1'
    await expect(call('read_file', { path: 'src/a.ts' })).resolves.toBe(expected)
    await expect(call('read_file', { path: join(cwd, 'src', 'a.ts') })).resolves.toBe(expected)
    await expect(call('read_file', { path: 'inner/a.ts' })).resolves.toBe(expected)
  })

  it('reads a file in an additional directory', async () => {
    await expect(call('read_file', { path: join(shared, 'doc.md') })).resolves.toBe('     1\tshared doc')
  })

  it('refuses a symlink that escapes the workspace', async () => {
    await expect(call('read_file', { path: 'escape_file.ts' })).rejects.toThrow(
      `escape_file.ts is outside the workspace; the file tools only reach paths under ${cwd}, ${shared}`,
    )
  })

  it('stops at read_limit_lines and says where the next read starts', async () => {
    const path = await read_fixture('five.txt', lines_text(5))
    await expect(call('read_file', { path }, { over: reading, tools: { read_limit_lines: 3 } })).resolves.toBe(
      `${shown_lines(1, 3)}\n\n[lines 1 to 3 shown; the file goes on, so read on with offset 4]`,
    )
    await expect(call('read_file', { path, offset: 4 }, { over: reading, tools: { read_limit_lines: 3 } })).resolves.toBe(
      shown_lines(4, 5),
    )
  })

  it('says nothing more when the window ends on the last line', async () => {
    const path = await read_fixture('three.txt', lines_text(3))
    await expect(call('read_file', { path }, { over: reading, tools: { read_limit_lines: 3 } })).resolves.toBe(shown_lines(1, 3))
  })

  it('reads 2000 lines at most unless the options say otherwise', async () => {
    const path = await read_fixture('long.txt', lines_text(2001))
    await expect(call('read_file', { path }, { over: reading })).resolves.toBe(
      `${shown_lines(1, 2000)}\n\n[lines 1 to 2000 shown; the file goes on, so read on with offset 2001]`,
    )
  })

  it('reads from offset for limit lines', async () => {
    const path = await read_fixture('window.txt', lines_text(6))
    await expect(call('read_file', { path, offset: 2, limit: 2 }, { over: reading })).resolves.toBe(
      `${shown_lines(2, 3)}\n\n[lines 2 to 3 shown; the file goes on, so read on with offset 4]`,
    )
  })

  it('holds a limit above the cap to the cap', async () => {
    const path = await read_fixture('capped.txt', lines_text(4))
    await expect(call('read_file', { path, limit: 10 }, { over: reading, tools: { read_limit_lines: 2 } })).resolves.toBe(
      `${shown_lines(1, 2)}\n\n[lines 1 to 2 shown; the file goes on, so read on with offset 3]`,
    )
  })

  it('cuts a line past 2000 characters with a marker, and keeps one of exactly 2000 whole', async () => {
    const path = await read_fixture('wide.txt', `${'a'.repeat(2000)}\n${'b'.repeat(2001)}\n`)
    await expect(call('read_file', { path }, { over: reading })).resolves.toBe(
      `     1\t${'a'.repeat(2000)}\n     2\t${'b'.repeat(2000)} [line cut at 2000 of 2001 characters]`,
    )
  })

  it('refuses a file with a NUL byte in its first 8 KB as binary', async () => {
    const head = Buffer.alloc(8192, 'x')
    head[8191] = 0
    const path = await read_fixture('image.bin', head)
    await expect(call('read_file', { path }, { over: reading })).rejects.toThrow(
      'image.bin is a binary file (it has a NUL byte in its first 8 KB), so read_file won\'t read it',
    )
  })

  it('reads a NUL byte past the first 8 KB as text', async () => {
    const path = await read_fixture('late-nul.txt', `${'x\n'.repeat(4096)}a\0b\n`)
    await expect(call('read_file', { path, offset: 4097 }, { over: reading })).resolves.toBe('  4097\ta\0b')
  })

  it('closes the file after every read, one cut short or refused included', async () => {
    const path = await read_fixture('many.txt', lines_text(50))
    const binary = await read_fixture('blob.bin', Buffer.from([1, 0, 2]))
    const open_files = (): number => readdirSync('/dev/fd').length
    const before = open_files()
    for (const limit of [1, 2, 3]) {
      await call('read_file', { path, limit }, { over: reading })
      await call('read_file', { path }, { over: reading })
      await expect(call('read_file', { path: binary }, { over: reading })).rejects.toThrow(/binary file/)
    }
    expect(open_files()).toBe(before)
  })

  it('says an empty file is empty', async () => {
    const path = await read_fixture('empty.txt', '')
    await expect(call('read_file', { path }, { over: reading })).resolves.toBe('empty.txt is empty')
  })

  it('fails an offset past the last line, saying how many lines there are', async () => {
    await expect(call('read_file', { path: 'notes.md', offset: 9 })).rejects.toThrow(
      'offset 9 is past the end of notes.md, which has 3 lines',
    )
  })

  it("says a file that doesn't exist doesn't", async () => {
    await expect(call('read_file', { path: 'src/nope.ts' })).rejects.toThrow("src/nope.ts doesn't exist")
  })

  it('passes any other failure to read the file through', async () => {
    await expect(call('read_file', { path: 'notes.md/x' })).rejects.toThrow(/^ENOTDIR/)
  })

  it('points a directory at list_files', async () => {
    await expect(call('read_file', { path: 'src' })).rejects.toThrow("src is a directory; list_files shows what's in it")
  })

  it("refuses what isn't a regular file without opening it", async () => {
    execFileSync('mkfifo', [join(reads, 'pipe')])
    await expect(call('read_file', { path: 'pipe' }, { over: reading })).rejects.toThrow(
      "pipe isn't a regular file, so read_file can't read it",
    )
  })

  it.each([
    ['offset 0', { path: 'notes.md', offset: 0 }],
    ['limit 0', { path: 'notes.md', limit: 0 }],
    ['a fractional offset', { path: 'notes.md', offset: 1.5 }],
    ['an offset given as a string', { path: 'notes.md', offset: '2' }],
  ])('refuses %s, since it counts lines from 1', async (_, input) => {
    await expect(call('read_file', input)).rejects.toThrow(
      'read_file counts offset and limit in lines from 1, so each has to be a whole number of at least 1',
    )
  })

  it('refuses input without a path', async () => {
    await expect(call('read_file', { offset: 1 })).rejects.toThrow('read_file needs a path, as a string')
    await expect(call('read_file', 'notes.md')).rejects.toThrow('read_file needs a path, as a string')
  })
})

describe('list_files', () => {
  it('lists every regular file under cwd, sorted, skipping ignored names and every symlink', async () => {
    await expect(call('list_files', {})).resolves.toBe(['notes.md', 'src/a.ts', 'src/deep/b.ts', 'sub/keep.ts'].join('\n'))
  })

  it('matches a pattern', async () => {
    await expect(call('list_files', { pattern: '**/*.md' })).resolves.toBe('notes.md')
  })

  it('matches under path, showing paths relative to cwd', async () => {
    await expect(call('list_files', { pattern: '*.ts', path: 'src' })).resolves.toBe('src/a.ts')
  })

  it('lists an additional directory by its absolute paths', async () => {
    await expect(call('list_files', { path: shared })).resolves.toBe(join(shared, 'doc.md'))
  })

  it('never follows a symlinked directory, even when the pattern names it', async () => {
    await expect(call('list_files', { pattern: 'escape/*' })).resolves.toBe('no files match escape/* under .')
    await expect(call('list_files', { pattern: 'escape/**/*' })).resolves.toBe('no files match escape/**/* under .')
    await expect(call('list_files', { pattern: 'inner/*' })).resolves.toBe('no files match inner/* under .')
  })

  it('skips an ignored name at any depth, for a pattern that names its segments too', async () => {
    await expect(call('list_files', { pattern: '*/*/*/*' })).resolves.toBe('no files match */*/*/* under .')
    await expect(call('list_files', { pattern: 'node_modules/**/*' })).resolves.toBe('no files match node_modules/**/* under .')
    await expect(call('list_files', { pattern: 'sub/*' })).resolves.toBe('sub/keep.ts')
  })

  it('takes its ignored names from the options', async () => {
    await expect(call('list_files', { pattern: '**/*.ts' }, { tools: { ignore: [] } })).resolves.toBe(
      ['src/a.ts', 'src/deep/b.ts', 'sub/keep.ts', 'sub/node_modules/q/q.ts'].join('\n'),
    )
    await expect(call('list_files', {}, { tools: { ignore: ['src'] } })).resolves.toBe(
      ['node_modules/pkg/index.js', 'notes.md', 'sub/keep.ts', 'sub/node_modules/q/q.ts'].join('\n'),
    )
  })

  it('lists hidden files only when the pattern names the dot, and still skips an ignored one', async () => {
    await expect(call('list_files', { pattern: '**/.*' })).resolves.toBe('.env.example')
    await expect(call('list_files', { pattern: '**/.*' }, { tools: { ignore: [] } })).resolves.toBe(
      ['.env.example', 'sub/.git'].join('\n'),
    )
    await expect(call('list_files', { pattern: '.git/*' })).resolves.toBe('no files match .git/* under .')
    await expect(call('list_files', { pattern: '.git/*' }, { tools: { ignore: [] } })).resolves.toBe('.git/HEAD')
  })

  it.each([
    ['an absolute pattern', '/etc/*'],
    ['a pattern that climbs', '../outside/*'],
    ['a pattern that climbs midway', 'src/../../outside/*'],
    ['a pattern that climbs with a backslash', '..\\outside'],
  ])('refuses %s, pointing at path instead', async (_, pattern) => {
    await expect(call('list_files', { pattern })).rejects.toThrow(
      `list_files matches its pattern under path, so ${pattern} can't be absolute or climb with ..; pass the directory as path instead`,
    )
  })

  it('points a file given as path at read_file', async () => {
    await expect(call('list_files', { path: 'notes.md' })).rejects.toThrow(
      'notes.md is a file; list_files lists a directory, and read_file reads a file',
    )
  })

  it('passes a path that does not exist through as the error', async () => {
    await expect(call('list_files', { path: 'gone' })).rejects.toThrow(/^ENOENT/)
  })

  it('refuses a path outside the workspace', async () => {
    await expect(call('list_files', { path: '../outside' })).rejects.toThrow(
      `../outside is outside the workspace; the file tools only reach paths under ${cwd}, ${shared}`,
    )
  })

  it('says when nothing matches', async () => {
    await expect(call('list_files', { pattern: '**/*.rs', path: 'src' })).resolves.toBe('no files match **/*.rs under src')
  })

  it('stops when the turn is cancelled', async () => {
    const cancel = new AbortController()
    cancel.abort(new Error('the turn was cancelled'))
    await expect(call('list_files', {}, { abort: cancel.signal })).rejects.toThrow('the turn was cancelled')
  })

  it('refuses a pattern or path that is not a string', async () => {
    await expect(call('list_files', { pattern: 3 })).rejects.toThrow('list_files takes its pattern and path as strings')
    await expect(call('list_files', { path: 3 })).rejects.toThrow('list_files takes its pattern and path as strings')
  })
})
