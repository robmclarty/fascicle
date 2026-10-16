import { execFileSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { readdirSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Tool } from '#engine'
import { to_json_schema, validate_schema } from '#schema'
import { resolve_roots } from '../tools/containment.js'
import { search_files, search_tool } from '../tools/search.js'
import type { AcpSession } from '../types.js'
import { workspace_tools } from '../workspace_tools.js'

/**
 * The fixture, under one scratch directory:
 *
 *   project/               the workspace
 *     notes.md  crlf.txt  src/a.ts  src/deep/b.tsx      text with needles
 *     .github/ci.yml       hidden, so only a glob that names the dot reaches it
 *     .git/HEAD  node_modules/pkg/index.js              ignored names
 *     image.bin            a needle after a NUL byte
 *     escape -> outside    inner -> project/src         symlinks the walk skips
 *   outside/secret.ts      outside every root
 *   shared/doc.md          an additional directory
 *   lines/                 a second workspace, for files written by one test
 */
let base: string
let cwd: string
let shared: string
let lines: string
let session: AcpSession
let lined: AcpSession

/** The needles `search` finds under cwd with no glob, in order. */
const NEEDLES = ['crlf.txt:2: needle', 'notes.md:2: two needle', "src/a.ts:2: const needle = 'a'"].join('\n')

/** A session over `cwd` and the additional directories, its roots resolved the way `session/new` does. */
async function session_over(root: string, additional: string[] = []): Promise<AcpSession> {
  return {
    id: 'session-1',
    cwd: root,
    additional_directories: additional,
    roots: await resolve_roots([root, ...additional]),
    client_capabilities: {},
    mode: () => 'manual',
  }
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'fascicle-acp-search-')))
  cwd = join(base, 'project')
  shared = join(base, 'shared')
  lines = join(base, 'lines')
  await Promise.all(
    [
      join(cwd, 'src', 'deep'),
      join(cwd, '.github'),
      join(cwd, '.git'),
      join(cwd, 'node_modules', 'pkg'),
      join(base, 'outside'),
      shared,
      lines,
    ].map((dir) => mkdir(dir, { recursive: true })),
  )
  await Promise.all([
    writeFile(join(cwd, 'notes.md'), 'one\ntwo needle\nthree\n'),
    writeFile(join(cwd, 'crlf.txt'), 'first\r\nneedle\r\n'),
    writeFile(join(cwd, 'src', 'a.ts'), "export const a = 1\nconst needle = 'a'\n"),
    writeFile(join(cwd, 'src', 'deep', 'b.tsx'), 'export const b = <Needle />\n'),
    writeFile(join(cwd, '.github', 'ci.yml'), 'needle: hidden\n'),
    writeFile(join(cwd, '.git', 'HEAD'), 'needle in git\n'),
    writeFile(join(cwd, 'node_modules', 'pkg', 'index.js'), 'needle in a dependency\n'),
    writeFile(join(cwd, 'image.bin'), Buffer.from('\0needle\n')),
    writeFile(join(base, 'outside', 'secret.ts'), 'needle outside\n'),
    writeFile(join(shared, 'doc.md'), 'shared needle\n'),
  ])
  await Promise.all([symlink(join(base, 'outside'), join(cwd, 'escape')), symlink(join(cwd, 'src'), join(cwd, 'inner'))])
  session = await session_over(cwd, [shared])
  lined = await session_over(lines)
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A job for `search_files` over the project, as the tool builds one. */
function job(overrides: Partial<Parameters<typeof search_files>[0]> = {}): Parameters<typeof search_files>[0] {
  return {
    base: cwd,
    directory: true,
    pattern: 'needle',
    glob: '**/*',
    ignore: ['.git', 'node_modules'],
    limit: 100,
    ...overrides,
  }
}

/** A file under `lines`, written for one test, returning the name the model would pass. */
async function lines_fixture(name: string, content: string): Promise<string> {
  await writeFile(join(lines, name), content)
  return name
}

/** The workspace tools' `search` for a session. */
function search_in(over: AcpSession): Tool {
  const found = workspace_tools(over).find((tool) => tool.name === 'search')
  if (found === undefined) throw new Error('workspace_tools has no search')
  return found
}

/** Run a search tool's `execute` the way the tool loop would after validating its input. */
async function call(
  input: unknown,
  options: { over?: AcpSession; tool?: Tool; abort?: AbortSignal } = {},
): Promise<unknown> {
  const tool = options.tool ?? search_in(options.over ?? session)
  return tool.execute(input, { abort: options.abort ?? new AbortController().signal, tool_call_id: 'call_1', step_index: 0 })
}

describe('search_files', () => {
  it('finds the matching lines file by file in sorted order, numbered from 1, without their line endings', async () => {
    await expect(search_files(job())).resolves.toEqual({
      matches: [
        { file: 'crlf.txt', line: 2, text: 'needle' },
        { file: 'notes.md', line: 2, text: 'two needle' },
        { file: join('src', 'a.ts'), line: 2, text: "const needle = 'a'" },
      ],
      more: false,
    })
  })

  it('skips binary files, ignored names, hidden files, and every symlink', async () => {
    const files = (await search_files(job({ pattern: '.', ignore: [] }))).matches.map((match) => match.file)
    expect(new Set(files)).toEqual(
      new Set(['crlf.txt', 'notes.md', join('src', 'a.ts'), join('src', 'deep', 'b.tsx'), join('node_modules', 'pkg', 'index.js')]),
    )
  })

  it('reaches an ignored or hidden name only when the glob names it and the ignore list leaves it out', async () => {
    await expect(search_files(job({ glob: '.git/*' }))).resolves.toEqual({ matches: [], more: false })
    await expect(search_files(job({ glob: '.git/*', ignore: [] }))).resolves.toEqual({
      matches: [{ file: join('.git', 'HEAD'), line: 1, text: 'needle in git' }],
      more: false,
    })
    await expect(search_files(job({ glob: '**/.github/*' }))).resolves.toEqual({
      matches: [{ file: join('.github', 'ci.yml'), line: 1, text: 'needle: hidden' }],
      more: false,
    })
  })

  it('takes JavaScript regular expression syntax, inline modifiers and anchors included', async () => {
    const found = await search_files(job({ pattern: '(?i:needle) />$' }))
    expect(found.matches).toEqual([{ file: join('src', 'deep', 'b.tsx'), line: 1, text: 'export const b = <Needle />' }])
    expect((await search_files(job({ pattern: '^two' }))).matches).toEqual([{ file: 'notes.md', line: 2, text: 'two needle' }])
  })

  it('searches only the files the glob matches', async () => {
    await expect(search_files(job({ glob: 'src/**/*.ts' }))).resolves.toEqual({
      matches: [{ file: join('src', 'a.ts'), line: 2, text: "const needle = 'a'" }],
      more: false,
    })
  })

  it('searches the one file a job names, calling it by an empty relative path', async () => {
    await expect(search_files(job({ base: join(cwd, 'notes.md'), directory: false }))).resolves.toEqual({
      matches: [{ file: '', line: 2, text: 'two needle' }],
      more: false,
    })
  })

  it('stops one match past the limit, saying there are more, and not at a limit it reaches exactly', async () => {
    const name = await lines_fixture('three.txt', 'hit 1\nhit 2\nhit 3\n')
    const over = job({ base: lines, glob: name, pattern: 'hit' })
    await expect(search_files({ ...over, limit: 2 })).resolves.toEqual({
      matches: [
        { file: name, line: 1, text: 'hit 1' },
        { file: name, line: 2, text: 'hit 2' },
      ],
      more: true,
    })
    const exact = await search_files({ ...over, limit: 3 })
    expect(exact.matches.map((match) => match.line)).toEqual([1, 2, 3])
    expect(exact.more).toBe(false)
  })

  it('counts the empty lines a file has, and not the one after its final newline', async () => {
    const blank = await lines_fixture('blank.txt', 'a\n\nb\n')
    await lines_fixture('full.txt', 'x\ny\n')
    const open_end = await lines_fixture('open-end.txt', 'x\ny')
    await expect(search_files(job({ base: lines, glob: '{blank,full}.txt', pattern: '^$' }))).resolves.toEqual({
      matches: [{ file: blank, line: 2, text: '' }],
      more: false,
    })
    await expect(search_files(job({ base: lines, glob: open_end, pattern: '^y$' }))).resolves.toEqual({
      matches: [{ file: open_end, line: 2, text: 'y' }],
      more: false,
    })
  })

  it('shows a line of 500 characters whole, and a longer one as a 500-wide window that starts 100 before its match', async () => {
    const whole = `needle${'x'.repeat(494)}`
    const late = `${'x'.repeat(600)}needle${'x'.repeat(400)}`
    const early = `${'x'.repeat(50)}needle${'x'.repeat(944)}`
    const at_end = `${'x'.repeat(1000)}needle`
    await lines_fixture('wide.txt', [whole, late, early, at_end].join('\n'))
    const found = await search_files(job({ base: lines, glob: 'wide.txt' }))
    expect(found.matches.map((match) => match.text)).toEqual([
      whole,
      `${late.slice(500, 1000)} [columns 501 to 1000 of 1006]`,
      `${early.slice(0, 500)} [columns 1 to 500 of 1000]`,
      `${at_end.slice(506)} [columns 507 to 1006 of 1006]`,
    ])
  })

  it('reads a text file past its first 8 KB from the top', async () => {
    const name = await lines_fixture('long.txt', `needle first\n${'x\n'.repeat(8192)}needle last\n`)
    const found = await search_files(job({ base: lines, glob: name }))
    expect(found.matches).toEqual([
      { file: name, line: 1, text: 'needle first' },
      { file: name, line: 8194, text: 'needle last' },
    ])
  })

  it('closes every file it opens, text and binary alike', async () => {
    const open_files = (): number => readdirSync('/dev/fd').length
    const before = open_files()
    const found = await search_files(job({ pattern: '.', ignore: [] }))
    expect(found.matches.length).toBeGreaterThan(5)
    expect(open_files()).toBe(before)
  })

  it("throws the engine's own error for a pattern that isn't a regular expression", async () => {
    await expect(search_files(job({ pattern: '(' }))).rejects.toThrow(
      new SyntaxError('Invalid regular expression: /(/: Unterminated group'),
    )
  })
})

describe('search', () => {
  it('describes itself to the model with its cap and the names it skips, and declares its input as JSON Schema', () => {
    const tool = search_in(session)
    const description = [
      "Search the workspace's files for lines that match a regular expression, at most 100 per call,",
      'each shown as path:line: text; a path under the workspace root is shown relative to it.',
      'The pattern is a JavaScript regular expression matched against one line at a time; write (?i:...) for a part that ignores case.',
      'path (default: the workspace root) is the directory to search, or a single file.',
      'glob picks the files: without a slash it matches a file name at any depth (*.ts, *.{ts,tsx}),',
      'and with one it matches the path under path (src/**/*.ts).',
      'As in a shell, * and ** skip names that start with a dot, so name the dot to search hidden files (.github/**/*).',
    ].join(' ')
    expect(tool.description).toBe(`${description} Skips binary files and .git, node_modules.`)
    expect(workspace_tools(session, { ignore: [] }).find((each) => each.name === 'search')?.description).toBe(
      `${description} Skips binary files.`,
    )
    expect(to_json_schema(tool.input_schema)).toEqual({
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'A JavaScript regular expression, such as function\\s+\\w+' },
        path: {
          type: 'string',
          description: 'The directory or file to search, absolute or relative to the workspace root; default: the root',
        },
        glob: { type: 'string', description: 'Which files to search, such as *.ts or src/**/*.ts; default: **/*' },
      },
      required: ['pattern'],
      additionalProperties: false,
    })
  })

  it('validates input against the schema the tool loop checks before execute', async () => {
    const tool = search_in(session)
    expect((await validate_schema(tool.input_schema, { pattern: 'a', path: 'src', glob: '*.ts' })).ok).toBe(true)
    expect((await validate_schema(tool.input_schema, { path: 'src' })).ok).toBe(false)
    expect((await validate_schema(tool.input_schema, { pattern: 'a', glob: 3 })).ok).toBe(false)
  })

  it('runs in a worker loaded from the source tree and lists path:line: text relative to cwd', async () => {
    await expect(call({ pattern: 'needle' })).resolves.toBe(NEEDLES)
  })

  it('matches a glob without a slash at any depth, and one with a slash as a path under path', async () => {
    await expect(call({ pattern: '(?i:needle)', glob: '*.tsx' })).resolves.toBe('src/deep/b.tsx:1: export const b = <Needle />')
    await expect(call({ pattern: '(?i:needle)', glob: 'src/*' })).resolves.toBe("src/a.ts:2: const needle = 'a'")
    await expect(call({ pattern: 'needle', glob: '.github/*' })).resolves.toBe('.github/ci.yml:1: needle: hidden')
  })

  it('searches under path, or one file, or an additional directory, showing each path in the client terms', async () => {
    await expect(call({ pattern: 'needle', path: 'src' })).resolves.toBe("src/a.ts:2: const needle = 'a'")
    await expect(call({ pattern: 'needle', path: join(cwd, 'notes.md') })).resolves.toBe('notes.md:2: two needle')
    await expect(call({ pattern: 'needle', path: shared })).resolves.toBe(`${join(shared, 'doc.md')}:1: shared needle`)
  })

  it('refuses a path outside the workspace', async () => {
    await expect(call({ pattern: 'needle', path: 'escape' })).rejects.toThrow(
      `escape is outside the workspace; the file tools only reach paths under ${cwd}, ${shared}`,
    )
  })

  it("refuses what isn't a directory or a regular file, without reading it", async () => {
    execFileSync('mkfifo', [join(lines, 'pipe')])
    await expect(call({ pattern: 'needle', path: 'pipe' }, { over: lined })).rejects.toThrow(
      "pipe isn't a directory or a regular file, so search can't read it",
    )
  })

  it('passes a path that does not exist through as the error', async () => {
    await expect(call({ pattern: 'needle', path: 'gone' })).rejects.toThrow(/^ENOENT/)
  })

  it("reports a pattern that isn't a regular expression with the engine's message, from the worker", async () => {
    await expect(call({ pattern: '(' })).rejects.toThrow(new SyntaxError('Invalid regular expression: /(/: Unterminated group'))
  })

  it('says when nothing matches, naming the pattern, the path, and the glob', async () => {
    await expect(call({ pattern: 'zebra' })).resolves.toBe('no lines match zebra under . in files matching **/*')
    await expect(call({ pattern: 'zebra', path: 'src', glob: '*.ts' })).resolves.toBe(
      'no lines match zebra under src in files matching *.ts',
    )
  })

  it('stops at 100 matches and says how to see the rest', async () => {
    const name = await lines_fixture('many.txt', Array.from({ length: 101 }, (_, i) => `hit ${i + 1}\n`).join(''))
    const shown = Array.from({ length: 100 }, (_, i) => `${name}:${i + 1}: hit ${i + 1}`).join('\n')
    await expect(call({ pattern: 'hit', glob: name }, { over: lined })).resolves.toBe(
      `${shown}\n\n[the first 100 matches; narrow the pattern, path, or glob to see the rest]`,
    )
  })

  it.each([
    ['no pattern', { path: 'src' }],
    ['a pattern that is not a string', { pattern: 3 }],
    ['a path that is not a string', { pattern: 'a', path: 3 }],
    ['a glob that is not a string', { pattern: 'a', glob: 3 }],
    ['input that is not an object', 'needle'],
  ])('refuses %s', async (_, input) => {
    await expect(call(input)).rejects.toThrow('search needs a pattern, and takes its pattern, path, and glob as strings')
  })

  it('comes back with an error inside the budget for a pattern that backtracks without end, and ends its thread', async () => {
    const name = await lines_fixture('backtrack.txt', `${'a'.repeat(40)}b\n`)
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    const tool = search_tool(lined, [], 1500)
    let ticks = 0
    const ticking = setInterval(() => {
      ticks += 1
    }, 10)
    const started = performance.now()
    await expect(call({ pattern: '(a+)+$', glob: name }, { tool })).rejects.toThrow(
      'search stopped after 1.5 s without finishing: the pattern may backtrack without end, ' +
        'as nested quantifiers such as (a+)+ can, or there may be too much to search; ' +
        'simplify the pattern, or narrow path or glob',
    )
    const elapsed = performance.now() - started
    clearInterval(ticking)
    expect(elapsed).toBeGreaterThanOrEqual(1450)
    expect(elapsed).toBeLessThan(4000)
    // The main thread kept turning while the pattern backtracked.
    expect(ticks).toBeGreaterThan(30)
    expect(terminate).toHaveBeenCalledTimes(1)
    // CPU time counts every thread in the process, so a worker still
    // backtracking would spend about as much as the wait takes.
    const before = process.cpuUsage()
    await sleep(300)
    expect(process.cpuUsage(before).user).toBeLessThan(150_000)
  })

  it('stops a search when the turn is cancelled, well before the budget', async () => {
    const name = await lines_fixture('cancelled.txt', `${'a'.repeat(40)}b\n`)
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    const cancel = new AbortController()
    setTimeout(() => {
      cancel.abort(new Error('the turn was cancelled'))
    }, 300)
    const started = performance.now()
    await expect(call({ pattern: '(a+)+$', glob: name }, { over: lined, abort: cancel.signal })).rejects.toThrow(
      'the turn was cancelled',
    )
    expect(performance.now() - started).toBeLessThan(4000)
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  it('refuses at once when the turn is already cancelled', async () => {
    const cancel = new AbortController()
    cancel.abort(new Error('the turn was cancelled'))
    await expect(call({ pattern: 'needle' }, { abort: cancel.signal })).rejects.toThrow('the turn was cancelled')
  })

  it('leaves no timer or abort listener behind once the search is done', async () => {
    // Faked on this thread only, so the budget's timer is the one counted;
    // the worker keeps real timers and answers through a message.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const turn = new AbortController()
      await expect(call({ pattern: 'needle' }, { abort: turn.signal })).resolves.toBe(NEEDLES)
      expect(vi.getTimerCount()).toBe(0)
      expect(getEventListeners(turn.signal, 'abort')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
