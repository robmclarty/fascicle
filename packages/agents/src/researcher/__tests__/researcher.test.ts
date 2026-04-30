import { aborted_error, run } from '@repo/core'
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core'
import type { Engine, GenerateOptions, GenerateResult } from '@repo/engine'
import { afterEach, describe, expect, it } from 'vitest'
import { researcher, type FetchFn, type SearchFn } from '../index.js'
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

type ScriptedHarness = {
  readonly engine: Engine
  readonly search: SearchFn
  readonly fetch: FetchFn
  readonly engine_calls: { count: number }
  readonly search_queries: string[]
  readonly fetched_urls: string[]
}

function make_scripted_harness(script: RoundScript): ScriptedHarness {
  const engine_calls = { count: 0 }
  const search_queries: string[] = []
  const fetched_urls: string[] = []

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
    register_alias: () => {},
    unregister_alias: () => {},
    resolve_alias: () => ({ provider: 'mock', model_id: 'res' }),
    list_aliases: () => ({}),
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    dispose: async () => {},
  }

  return { engine, search, fetch, engine_calls, search_queries, fetched_urls }
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
      register_alias: () => {},
      unregister_alias: () => {},
      resolve_alias: () => ({ provider: 'mock', model_id: 'res' }),
      list_aliases: () => ({}),
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
})
