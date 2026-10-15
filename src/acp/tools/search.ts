/**
 * search: find the lines in the workspace's files that match a regular
 * expression.
 *
 * The pattern is the model's, and JavaScript's `RegExp` backtracks, so a
 * pattern such as `(a+)+$` against one long line can run for minutes. No
 * abort interrupts synchronous code, and one agent process serves every
 * session, so a search on the main thread could leave even `session/cancel`
 * unanswered. Each search runs in a worker thread instead, which the turn's
 * abort and a time budget can terminate mid-match. The worker is a thin
 * shell, `search_worker.ts`: what it runs is `search_files`, here, where
 * the tests call it on the main thread.
 *
 * The search walks the files itself, with `list_files`' walk, rather than
 * handing the work to `rg`, because the module keeps child processes to
 * `run_command`.
 */

import { open, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Tool } from '#engine'
import { as_record, json_schema_to_standard } from '#schema'
import type { AcpSession } from '../types.js'
import { contain, shown_path } from './containment.js'
import { walk } from './list_files.js'
import { is_binary } from './read_file.js'

/** What `search` matches when the call names no glob. */
const ALL_FILES = '**/*'

/** The most matches one call returns. */
const MATCH_LIMIT = 100

/**
 * The longest matching line shown whole. A longer one is shown as a window
 * this wide around its match, since a minified bundle is one line of
 * megabytes and every match in it would otherwise carry the whole line.
 */
const LINE_WIDTH = 500

/** How much of a long line its window shows before the match. */
const LINE_LEAD = 100

/**
 * The search worker, beside this module with its extension: `.ts` in the
 * source tree, where vitest and Stryker run it, and `.js` once built.
 */
const SEARCH_WORKER = new URL(`./search_worker${extname(import.meta.url)}`, import.meta.url)

/** One search as the model asked for it. */
type SearchRequest = {
  readonly pattern: string
  readonly path: string
  readonly glob: string
}

/** One search as the worker runs it: plain data, since it crosses to another thread. */
type SearchJob = {
  /** The real path of the directory to walk, or of the one file to search. */
  readonly base: string
  readonly directory: boolean
  readonly pattern: string
  /** The glob as the walk matches it, relative to `base`. */
  readonly glob: string
  readonly ignore: ReadonlyArray<string>
  readonly limit: number
}

/**
 * One matching line: its file relative to the job's base (empty when the
 * base is that file), its number counting from 1, and its text.
 */
type SearchMatch = {
  readonly file: string
  readonly line: number
  readonly text: string
}

/** The matches, and whether the search stopped at its limit with more to find. */
type SearchResult = {
  readonly matches: ReadonlyArray<SearchMatch>
  readonly more: boolean
}

/**
 * Read the call's pattern, path, and glob out of its input. The pattern
 * compiles in the worker, which reports one that isn't a regular expression
 * with the engine's own message.
 */
function search_request(input: unknown): SearchRequest {
  const fields: Record<string, unknown> = as_record(input) ?? {}
  const { pattern, path = '.', glob = ALL_FILES } = fields
  if (typeof pattern !== 'string' || typeof path !== 'string' || typeof glob !== 'string') {
    throw new Error('search needs a pattern, and takes its pattern, path, and glob as strings')
  }
  return { pattern, path, glob }
}

/**
 * The glob as the walk matches it. Like `rg --glob`, a glob without a slash
 * names files at any depth, so `*.ts` reaches `src/a.ts`, while one with a
 * slash matches the path under the searched directory.
 */
function walk_glob(glob: string): string {
  return glob.includes('/') ? glob : `**/${glob}`
}

/**
 * The files a job searches, relative to its base: the one file, or every
 * file the walk keeps, sorted so the same search stops at the same match
 * every time.
 */
async function files_of(job: SearchJob): Promise<string[]> {
  if (!job.directory) return ['']
  const found: string[] = []
  // Nothing inside the worker cancels the walk: the turn's abort and the
  // budget terminate the whole thread instead.
  const abort = new AbortController().signal
  await walk(job.base, '', { pattern: job.glob, ignored: new Set(job.ignore), abort, found })
  return found.toSorted()
}

/**
 * A file's text, or nothing for a binary file, which then has no lines to
 * search.
 */
async function file_text(path: string): Promise<string> {
  const handle = await open(path)
  try {
    // The binary check reads at an explicit position, which leaves the
    // handle's own position at the top, where readFile starts.
    return (await is_binary(handle)) ? '' : await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * A text's lines without their endings, and without the empty one after a
 * final newline, which isn't a line of the file.
 */
function lines_of(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * A matching line as `search` shows it: whole up to LINE_WIDTH characters,
 * and past that, a window that wide starting LINE_LEAD characters before
 * the match, kept inside the line, with the columns it covers.
 */
function excerpt(line: string, at: number): string {
  if (line.length <= LINE_WIDTH) return line
  const start = Math.max(0, Math.min(at - LINE_LEAD, line.length - LINE_WIDTH))
  return `${line.slice(start, start + LINE_WIDTH)} [columns ${start + 1} to ${start + LINE_WIDTH} of ${line.length}]`
}

/**
 * Search a job's files, in order, for the lines its pattern matches,
 * stopping at the first match past the limit, which says there are more.
 * The search worker runs this, and the tests call it on the main thread,
 * where Stryker can switch its mutants on.
 */
export async function search_files(job: SearchJob): Promise<SearchResult> {
  const regex = new RegExp(job.pattern)
  const matches: SearchMatch[] = []
  for (const file of await files_of(job)) {
    for (const [index, line] of lines_of(await file_text(join(job.base, file))).entries()) {
      const found = regex.exec(line)
      if (found === null) continue
      if (matches.length === job.limit) return { matches, more: true }
      matches.push({ file, line: index + 1, text: excerpt(line, found.index) })
    }
  }
  return { matches, more: false }
}

/**
 * Run one job in a search worker. The turn's abort and the budget each
 * terminate the thread, mid-match if need be, which nothing could do to a
 * pattern running on the main thread. However the search ends, the abort
 * listener and the budget's timer go with it.
 */
async function in_worker(job: SearchJob, budget_ms: number, abort: AbortSignal): Promise<SearchResult> {
  abort.throwIfAborted()
  const worker = new Worker(SEARCH_WORKER, { workerData: job })
  const { promise, resolve, reject } = Promise.withResolvers<SearchResult>()
  const stop = (reason: unknown): void => {
    void worker.terminate()
    reject(reason)
  }
  const on_abort = (): void => {
    stop(abort.reason)
  }
  const over_budget = new Error(
    `search stopped after ${budget_ms / 1000} s without finishing: the pattern may backtrack without end, ` +
      'as nested quantifiers such as (a+)+ can, or there may be too much to search; ' +
      'simplify the pattern, or narrow path or glob',
  )
  const budget = setTimeout(stop, budget_ms, over_budget)
  abort.addEventListener('abort', on_abort)
  worker.once('message', resolve)
  worker.once('error', reject)
  try {
    return await promise
  } finally {
    clearTimeout(budget)
    abort.removeEventListener('abort', on_abort)
  }
}

/**
 * The matches as the model reads them, one `path:line: text` to a line, and
 * a note when the search stopped at its limit.
 */
function report(session: AcpSession, base: string, request: SearchRequest, result: SearchResult): string {
  if (result.matches.length === 0) {
    return `no lines match ${request.pattern} under ${request.path} in files matching ${request.glob}`
  }
  const lines = result.matches.map(
    (match) => `${shown_path(session, join(base, match.file))}:${match.line}: ${match.text}`,
  )
  if (result.more) {
    lines.push('', `[the first ${result.matches.length} matches; narrow the pattern, path, or glob to see the rest]`)
  }
  return lines.join('\n')
}

/**
 * The `search` tool for one session: the lines under a path in its
 * workspace that match a regular expression, skipping binary files and the
 * `ignore` names, at most MATCH_LIMIT per call, each search in a worker
 * that the turn's abort and `budget_ms` can terminate.
 */
export function search_tool(session: AcpSession, ignore: ReadonlyArray<string>, budget_ms: number): Tool {
  return {
    name: 'search',
    description: [
      `Search the workspace's files for lines that match a regular expression, at most ${MATCH_LIMIT} per call,`,
      'each shown as path:line: text; a path under the workspace root is shown relative to it.',
      'The pattern is a JavaScript regular expression matched against one line at a time; write (?i:...) for a part that ignores case.',
      'path (default: the workspace root) is the directory to search, or a single file.',
      'glob picks the files: without a slash it matches a file name at any depth (*.ts, *.{ts,tsx}),',
      'and with one it matches the path under path (src/**/*.ts).',
      'As in a shell, * and ** skip names that start with a dot, so name the dot to search hidden files (.github/**/*).',
      ignore.length === 0 ? 'Skips binary files.' : `Skips binary files and ${ignore.join(', ')}.`,
    ].join(' '),
    input_schema: json_schema_to_standard({
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'A JavaScript regular expression, such as function\\s+\\w+' },
        path: {
          type: 'string',
          description: 'The directory or file to search, absolute or relative to the workspace root; default: the root',
        },
        glob: { type: 'string', description: `Which files to search, such as *.ts or src/**/*.ts; default: ${ALL_FILES}` },
      },
      required: ['pattern'],
      additionalProperties: false,
    }),
    execute: async (input, ctx) => {
      const request = search_request(input)
      const base = await contain(session, request.path)
      const info = await stat(base.real)
      if (!info.isDirectory() && !info.isFile()) {
        throw new Error(`${request.path} isn't a directory or a regular file, so search can't read it`)
      }
      const job: SearchJob = {
        base: base.real,
        directory: info.isDirectory(),
        pattern: request.pattern,
        glob: walk_glob(request.glob),
        ignore,
        limit: MATCH_LIMIT,
      }
      return report(session, base.path, request, await in_worker(job, budget_ms, ctx.abort))
    },
  }
}
