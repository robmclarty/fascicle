import { aborted_error, run } from '#core'
import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import type { Engine, GenerateOptions, GenerateResult } from '#engine'
import { afterEach, describe, expect, it } from 'vitest'
import { researcher, type FetchFn, type SearchFn } from '../index.js'
import { format_summarizer_user } from '../agent.js'
import type { SearchHit, SummarizerOutput } from '../schema.js'

function recording_logger(): { logger: TrajectoryLogger; events: TrajectoryEvent[] } {
  const events: TrajectoryEvent[] = []
  let id = 0
  const logger: TrajectoryLogger = {
    record: (event) => {
      events.push(event)
    },
    start_span: (name, meta) => {
      id += 1
      const span_id = `span_${id}`
      events.push({ kind: 'span_start', span_id, name, ...meta })
      return span_id
    },
    end_span: (span_id, meta) => {
      events.push({ kind: 'span_end', span_id, ...meta })
    },
  }
  return { logger, events }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const slow_search: SearchFn = async () => [{ url: 'https://slow/' }]
const slow_fetch: FetchFn = (_url, ctx) =>
  new Promise<string>((_resolve, reject) => {
    if (ctx.abort.aborted) {
      reject(new Error('aborted'))
      return
    }
    ctx.abort.addEventListener('abort', () => reject(new Error('aborted')), {
      once: true,
    })
  })

type RoundScript = ReadonlyArray<{
  readonly hits: ReadonlyArray<SearchHit>
  readonly contents: Readonly<Record<string, string>>
  readonly summary: SummarizerOutput
}>

type CapturedCall = { readonly prompt: string; readonly system: string | undefined }

type ScriptedHarness = {
  readonly engine: Engine
  readonly search: SearchFn
  readonly fetch: FetchFn
  readonly engine_calls: { count: number }
  readonly search_queries: string[]
  readonly fetched_urls: string[]
  readonly engine_opts: CapturedCall[]
}

function make_scripted_harness(script: RoundScript): ScriptedHarness {
  const engine_calls = { count: 0 }
  const search_queries: string[] = []
  const fetched_urls: string[] = []
  const engine_opts: CapturedCall[] = []

  const search: SearchFn = async (query) => {
    search_queries.push(query)
    const idx = search_queries.length - 1
    return script[idx]?.hits ?? []
  }
  const fetch: FetchFn = async (url) => {
    fetched_urls.push(url)
    for (const round of script) {
      const c = round.contents[url]
      if (c !== undefined) return c
    }
    return ''
  }

  const engine: Engine = {
    generate: async <t = string>(opts: GenerateOptions<t>): Promise<GenerateResult<t>> => {
      const idx = engine_calls.count
      engine_calls.count += 1
      engine_opts.push({
        prompt: typeof opts.prompt === 'string' ? opts.prompt : JSON.stringify(opts.prompt),
        system: opts.system,
      })
      const round = script[idx]
      if (!round) throw new Error(`scripted engine ran out of rounds (call ${String(idx + 1)})`)
      const parsed = opts.schema ? opts.schema.parse(round.summary) : round.summary
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: parsed as t,
        tool_calls: [],
        steps: [],
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: 'stop',
        model_resolved: { provider: 'mock', model_id: 'res' },
      }
    },
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    dispose: async () => {},
  }

  return { engine, search, fetch, engine_calls, search_queries, fetched_urls, engine_opts }
}

describe('researcher', () => {
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) process.off('SIGINT', l)
    for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l)
  })

  it('shallow depth runs exactly one round of search → fetch → summarize', async () => {
    const harness = make_scripted_harness([
      {
        hits: [
          { url: 'https://a/', title: 'A' },
          { url: 'https://b/', title: 'B' },
          { url: 'https://c/', title: 'C' },
        ],
        contents: {
          'https://a/': 'first page contents',
          'https://b/': 'second page contents',
          'https://c/': 'third page contents',
        },
        summary: {
          notes: 'one round done',
          brief: 'shallow brief',
          refined_query: 'next round query (unused for shallow)',
          has_enough: false,
          new_sources: [{ url: 'https://a/', title: 'A' }, { url: 'https://b/', title: 'B' }],
        },
      },
    ])
  
    const agent = researcher({
      engine: harness.engine,
      search: harness.search,
      fetch: harness.fetch,
    })
    const result = await run(
      agent,
      { query: 'what is fascicle', depth: 'shallow' },
      { install_signal_handlers: false },
    )
  
    expect(harness.search_queries).toEqual(['what is fascicle'])
    expect(harness.fetched_urls).toEqual(['https://a/', 'https://b/'])
    expect(harness.engine_calls.count).toBe(1)
    expect(result.brief).toBe('shallow brief')
    expect(result.notes).toBe('one round done')
    expect(result.sources.map((s) => s.url)).toEqual(['https://a/', 'https://b/'])
  })

  it('exits early when the summarizer reports has_enough=true', async () => {
    const harness = make_scripted_harness([
      {
        hits: [{ url: 'https://a/', title: 'A' }, { url: 'https://b/', title: 'B' }],
        contents: { 'https://a/': 'a', 'https://b/': 'b' },
        summary: {
          notes: 'enough',
          brief: 'standard brief r1',
          refined_query: 'unused',
          has_enough: true,
          new_sources: [{ url: 'https://a/' }],
        },
      },
    ])
  
    const agent = researcher({
      engine: harness.engine,
      search: harness.search,
      fetch: harness.fetch,
    })
    const result = await run(
      agent,
      { query: 'q', depth: 'standard' },
      { install_signal_handlers: false },
    )
  
    expect(harness.engine_calls.count).toBe(1)
    expect(harness.search_queries).toHaveLength(1)
    expect(result.brief).toBe('standard brief r1')
  })

  it('refined_query feeds the next round of search', async () => {
    const harness = make_scripted_harness([
      {
        hits: [{ url: 'https://r1/' }],
        contents: { 'https://r1/': 'round 1 contents' },
        summary: {
          notes: 'r1',
          brief: 'r1 brief',
          refined_query: 'narrower query',
          has_enough: false,
          new_sources: [{ url: 'https://r1/' }],
        },
      },
      {
        hits: [{ url: 'https://r2/' }],
        contents: { 'https://r2/': 'round 2 contents' },
        summary: {
          notes: 'r2',
          brief: 'r2 brief',
          refined_query: 'unused',
          has_enough: true,
          new_sources: [{ url: 'https://r2/' }],
        },
      },
    ])
  
    const agent = researcher({
      engine: harness.engine,
      search: harness.search,
      fetch: harness.fetch,
    })
    const result = await run(
      agent,
      { query: 'initial', depth: 'standard' },
      { install_signal_handlers: false },
    )
  
    expect(harness.search_queries).toEqual(['initial', 'narrower query'])
    expect(result.sources.map((s) => s.url)).toEqual(['https://r1/', 'https://r2/'])
    expect(result.brief).toBe('r2 brief')
  })

  it('exits early when search returns no fresh hits', async () => {
    const harness = make_scripted_harness([
      {
        hits: [{ url: 'https://a/' }],
        contents: { 'https://a/': 'a' },
        summary: {
          notes: 'r1',
          brief: 'b1',
          refined_query: 'q2',
          has_enough: false,
          new_sources: [{ url: 'https://a/' }],
        },
      },
      {
        // round 2: search returns only the already-visited URL
        hits: [{ url: 'https://a/' }],
        contents: { 'https://a/': 'a' },
        // unused — engine should not be called for round 2
        summary: {
          notes: 'should not run',
          brief: 'should not run',
          refined_query: '',
          has_enough: true,
          new_sources: [],
        },
      },
    ])
  
    const agent = researcher({
      engine: harness.engine,
      search: harness.search,
      fetch: harness.fetch,
    })
    const result = await run(
      agent,
      { query: 'q', depth: 'standard' },
      { install_signal_handlers: false },
    )
  
    expect(harness.engine_calls.count).toBe(1)
    // Round 2 finds no fresh hits and stops; the loop must not run a 3rd search.
    expect(harness.search_queries).toHaveLength(2)
    expect(result.brief).toBe('b1')
  })

  it('uses standard depth by default (top-k=3 picked from search hits)', async () => {
    const harness = make_scripted_harness([
      {
        hits: [
          { url: 'https://1/' },
          { url: 'https://2/' },
          { url: 'https://3/' },
          { url: 'https://4/' },
          { url: 'https://5/' },
        ],
        contents: {
          'https://1/': 'a',
          'https://2/': 'b',
          'https://3/': 'c',
          'https://4/': 'd',
          'https://5/': 'e',
        },
        summary: {
          notes: '',
          brief: 'brief',
          refined_query: '',
          has_enough: true,
          new_sources: [],
        },
      },
    ])
  
    const agent = researcher({
      engine: harness.engine,
      search: harness.search,
      fetch: harness.fetch,
    })
    await run(agent, { query: 'q' }, { install_signal_handlers: false })
    expect(harness.fetched_urls).toEqual(['https://1/', 'https://2/', 'https://3/'])
  })

  it('opens a span named after the agent', async () => {
    const harness = make_scripted_harness([
      {
        hits: [{ url: 'https://a/' }],
        contents: { 'https://a/': 'a' },
        summary: {
          notes: 'n',
          brief: 'b',
          refined_query: '',
          has_enough: true,
          new_sources: [],
        },
      },
    ])
    const agent = researcher({
      engine: harness.engine,
      search: harness.search,
      fetch: harness.fetch,
    })
    expect(agent.id.startsWith('researcher_')).toBe(true)
  
    const { logger, events } = recording_logger()
    await run(agent, { query: 'q', depth: 'shallow' }, {
      trajectory: logger,
      install_signal_handlers: false,
    })
  
    const labels = events
      .filter((e) => e.kind === 'span_start')
      .map((e) => e['name'] as string)
    expect(labels).toContain('researcher')
  })

  it('honors a name override on the outer compose label', async () => {
    const harness = make_scripted_harness([
      {
        hits: [{ url: 'https://a/' }],
        contents: { 'https://a/': 'a' },
        summary: {
          notes: 'n',
          brief: 'b',
          refined_query: '',
          has_enough: true,
          new_sources: [],
        },
      },
    ])
    const agent = researcher({
      engine: harness.engine,
      search: harness.search,
      fetch: harness.fetch,
      name: 'study',
    })
    const { logger, events } = recording_logger()
    await run(agent, { query: 'q', depth: 'shallow' }, {
      trajectory: logger,
      install_signal_handlers: false,
    })
    const labels = events
      .filter((e) => e.kind === 'span_start')
      .map((e) => e['name'] as string)
    expect(labels).toContain('study')
  })

  it('propagates abort during a slow fetch', async () => {
    const engine: Engine = {
      generate: async () => {
        throw new Error('engine should not be reached')
      },
      register_price: () => {},
      resolve_price: () => undefined,
      list_prices: () => ({}),
      dispose: async () => {},
    }
  
    const agent = researcher({ engine, search: slow_search, fetch: slow_fetch })
    const pending = run(agent, { query: 'q', depth: 'shallow' })
    await wait(20)
    process.emit('SIGINT')
    await expect(pending).rejects.toBeInstanceOf(aborted_error)
  })

  it('deep depth fetches up to top-k=4 pages', async () => {
    const harness = make_scripted_harness([
      {
        hits: [
          { url: 'https://1/' },
          { url: 'https://2/' },
          { url: 'https://3/' },
          { url: 'https://4/' },
          { url: 'https://5/' },
        ],
        contents: { 'https://1/': 'a', 'https://2/': 'b', 'https://3/': 'c', 'https://4/': 'd' },
        summary: {
          notes: '',
          brief: 'deep brief',
          refined_query: '',
          has_enough: true,
          new_sources: [],
        },
      },
    ])
    const agent = researcher({
      engine: harness.engine,
      search: harness.search,
      fetch: harness.fetch,
    })
    await run(agent, { query: 'q', depth: 'deep' }, { install_signal_handlers: false })
    expect(harness.fetched_urls).toEqual(['https://1/', 'https://2/', 'https://3/', 'https://4/'])
  })

  it('returns empty output when the first round finds no hits', async () => {
    const harness = make_scripted_harness([
      {
        hits: [],
        contents: {},
        summary: {
          notes: 'unused',
          brief: 'unused',
          refined_query: '',
          has_enough: false,
          new_sources: [],
        },
      },
    ])
    const agent = researcher({
      engine: harness.engine,
      search: harness.search,
      fetch: harness.fetch,
    })
    const result = await run(agent, { query: 'q', depth: 'shallow' }, {
      install_signal_handlers: false,
    })
    expect(harness.engine_calls.count).toBe(0)
    expect(result.brief).toBe('')
    expect(result.notes).toBe('')
    expect(result.sources).toEqual([])
  })

  it('sends the summarizer system prompt and a formatted user prompt to the engine', async () => {
    const harness = make_scripted_harness([
      {
        hits: [{ url: 'https://a/', title: 'Titled A' }, { url: 'https://b/' }],
        contents: { 'https://a/': 'page body alpha', 'https://b/': 'page body beta' },
        summary: {
          notes: 'n',
          brief: 'b',
          refined_query: '',
          has_enough: true,
          new_sources: [],
        },
      },
    ])
    const agent = researcher({
      engine: harness.engine,
      search: harness.search,
      fetch: harness.fetch,
    })
    await run(agent, { query: 'find alpha', depth: 'shallow' }, { install_signal_handlers: false })

    const call = harness.engine_opts[0]
    expect(call).toBeDefined()
    // System prompt comes from summarizer.md, not some other file.
    expect(call?.system).toContain('exacting research summarizer')
    // User prompt carries the query and a numbered page block. A page with a
    // title renders "Title <url>"; one without renders just "<url>".
    expect(call?.prompt).toContain('find alpha')
    expect(call?.prompt).toContain('[1] Titled A <https://a/>\npage body alpha')
    expect(call?.prompt).toContain('[2] <https://b/>\npage body beta')
  })

  it('traces the dispatcher, round, and guard steps by id', async () => {
    const harness = make_scripted_harness([
      {
        hits: [{ url: 'https://a/' }],
        contents: { 'https://a/': 'a' },
        summary: {
          notes: 'n',
          brief: 'b',
          refined_query: '',
          has_enough: true,
          new_sources: [],
        },
      },
    ])
    const agent = researcher({
      engine: harness.engine,
      search: harness.search,
      fetch: harness.fetch,
    })
    const { logger, events } = recording_logger()
    await run(agent, { query: 'q', depth: 'shallow' }, {
      trajectory: logger,
      install_signal_handlers: false,
    })
    // Spans label by kind; the step id rides in the span meta.
    const ids = events.filter((e) => e.kind === 'span_start').map((e) => e['id'] as string)
    expect(ids).toContain('researcher_dispatcher')
    expect(ids).toContain('researcher_round')
    expect(ids).toContain('researcher_guard')
  })
})

describe('format_summarizer_user', () => {
  it('formats the original query, refined query, notes, and a numbered page block', () => {
    const out = format_summarizer_user({
      original_query: 'oq',
      query: 'rq',
      notes_so_far: 'prior notes',
      pages: [
        { url: 'https://a/', title: 'Title A', contents: 'body a' },
        { url: 'https://b/', contents: 'body b' },
      ],
    })
    expect(out).toBe(
      [
        'Original query: oq',
        'Refined query for this round: rq',
        '',
        'Notes so far:\nprior notes',
        '',
        'New pages:\n',
        '[1] Title A <https://a/>\nbody a',
        '',
        '[2] <https://b/>\nbody b',
      ].join('\n'),
    )
  })

  it('renders "(none yet)" when there are no prior notes', () => {
    const out = format_summarizer_user({
      original_query: 'oq',
      query: 'rq',
      notes_so_far: '',
      pages: [{ url: 'https://a/', contents: 'c' }],
    })
    expect(out).toContain('Notes so far:\n(none yet)')
  })
})
