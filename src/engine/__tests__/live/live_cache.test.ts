/**
 * Opt-in live prompt-caching check.
 *
 * Runs a three-turn tool loop on Claude with a system prompt well over the
 * largest minimum a Claude model caches (4,096 tokens), and checks that the
 * first turn writes the cache and the next two read it. The mocked suite can
 * only show that `cache_control` goes out; whether the provider caches, and
 * what that saves, are facts about a live wire. Run it with:
 *
 *   LIVE_TESTS=1 OPENROUTER_API_KEY=... pnpm exec vitest run src/engine/__tests__/live/live_cache.test.ts
 *
 * Each block is skipped unless LIVE_TESTS=1 and its key are set. With
 * OPENROUTER_API_KEY, the `anthropic` provider's native transport reaches
 * Claude through OpenRouter's Anthropic-compatible Messages endpoint and
 * caches by default, since the loop has tools, and the `openrouter`
 * provider's native transport runs the same loop with an explicit
 * `cache: '5m'`, then once more on a model from another vendor, printing
 * whether OpenRouter ignored the field or refused the request. With
 * ANTHROPIC_API_KEY, the `anthropic` case calls the API directly.
 *
 * Which upstream serves a request is OpenRouter's call, and a cache lives with
 * the upstream that wrote it. The Claude runs on OpenRouter send a
 * `session_id`, so routing sticks from the first successful request, and pin
 * an upstream only when LIVE_CACHE_PIN names one. Every turn prints the
 * upstream its response names, so a turn that landed elsewhere reads as
 * routing rather than a bug, and the run can go again with a pin.
 *
 *   LIVE_CACHE_MODEL         the OpenRouter id (default anthropic/claude-sonnet-5.5)
 *   LIVE_CACHE_API_MODEL     the Anthropic API id (default claude-sonnet-5-5)
 *   LIVE_CACHE_OTHER_MODEL   the non-Claude model (default openai/gpt-5.5)
 *   LIVE_CACHE_PIN           an OpenRouter upstream name to pin the Claude runs to
 */

import { randomInt, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import { create_engine } from '../../create_engine.js'
import { DEFAULT_PRICING } from '../../pricing.js'
import type { CacheSetting, GenerateResult, Tool } from '../../types.js'

const live = process.env['LIVE_TESTS'] === '1'
const openrouter_key = process.env['OPENROUTER_API_KEY'] ?? ''
const anthropic_key = process.env['ANTHROPIC_API_KEY'] ?? ''
const pin = process.env['LIVE_CACHE_PIN'] ?? ''
const OPENROUTER_MODEL = process.env['LIVE_CACHE_MODEL'] ?? 'anthropic/claude-sonnet-5.5'
const API_MODEL = process.env['LIVE_CACHE_API_MODEL'] ?? 'claude-sonnet-5-5'
const OTHER_MODEL = process.env['LIVE_CACHE_OTHER_MODEL'] ?? 'openai/gpt-5.5'

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const TIMEOUT_MS = 300_000

// The engine reads no model id, so a run on an OpenRouter id needs the
// row registered under the id it calls before it can carry a cost.
const SONNET_PRICE = DEFAULT_PRICING['anthropic:claude-sonnet-5-5']

// About 7,000 tokens of reference text, the same on every turn, so the
// prefix clears every Claude model's minimum and stays byte-identical.
const SYSTEM = [
  'You are a careful bookkeeper who follows instructions exactly.',
  'The audit codes below are reference material for other tasks. Never mention them.',
  ...Array.from({ length: 280 }, (_, i) => {
    const region = ['north', 'south', 'east', 'west'][i % 4] ?? 'north'
    return `Audit code ${String(i + 1)}: account ${String((i * 7919) % 10007)} reconciles against ledger ${String((i * 104729) % 9973)} in the ${region} region, reviewed in quarter ${String((i % 4) + 1)}.`
  }),
].join('\n')

const PROMPT = [
  'Call the draw tool exactly twice, one call per turn, never two calls in one turn.',
  'Pass running_total each time: 0 on the first call, then the number the first call returned.',
  'After the second call, reply with only the sum of the two numbers, as digits.',
].join('\n')

type Ledger = { readonly drawn: number[] }

/**
 * The tool and the ledger it writes, so the test knows the numbers the model
 * was given without trusting the model's account of them. Each call hands
 * back a fresh number, so the model has to add across turns.
 */
function make_tool(): { tool: Tool; ledger: Ledger } {
  const ledger: Ledger = { drawn: [] }
  const tool: Tool = {
    name: 'draw',
    description: 'Draws the next number. Pass the running total of the numbers drawn so far (0 before the first draw).',
    input_schema: z.object({ running_total: z.number().int() }),
    execute: () => {
      const number = randomInt(100, 1000)
      ledger.drawn.push(number)
      return { number }
    },
  }
  return { tool, ledger }
}

type LoopCase = {
  readonly label: string
  readonly provider: 'anthropic' | 'openrouter'
  readonly api_key: string
  readonly base_url?: string
  readonly model: string
  /** True for a Claude run on OpenRouter, which sends a session_id and any pin. */
  readonly routed: boolean
}

type Run = {
  result?: GenerateResult
  error?: unknown
  readonly events: TrajectoryEvent[]
  readonly upstreams: string[]
}

/**
 * Read one field off a value of unknown shape, so the reads below stay free
 * of casts.
 */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/**
 * The upstream a response names: OpenRouter's header when it sets one, else
 * the first `provider` field in the body, else unknown.
 */
async function read_upstream(response: Response): Promise<string> {
  const header = response.headers.get('x-openrouter-provider')
  if (header !== null && header.length > 0) return header
  try {
    const found = /"provider"\s*:\s*"([^"]+)"/.exec(await response.text())
    return found?.[1] ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * The provider options a Claude run on OpenRouter sends: a session id, so
 * routing sticks from the first request, and the pin when one is set. A run
 * anywhere else sends none.
 */
function routing_options(c: LoopCase, session_id: string): Record<string, unknown> | undefined {
  if (!c.routed) return undefined
  return {
    [c.provider]: {
      session_id,
      ...(pin.length > 0 ? { provider: { order: [pin], allow_fallbacks: false } } : {}),
    },
  }
}

/**
 * Run the loop once on the native transport, watching each response for the
 * upstream that served it. A throw is kept as the run's outcome so the
 * case's lines print before it fails.
 */
async function run_loop(c: LoopCase, cache: CacheSetting | undefined): Promise<Run> {
  const engine = create_engine({
    providers: {
      [c.provider]: {
        api_key: c.api_key,
        transport: 'native',
        ...(c.base_url === undefined ? {} : { base_url: c.base_url }),
      },
    },
  })
  if (c.provider === 'anthropic' && SONNET_PRICE !== undefined) {
    engine.register_price(c.provider, c.model, SONNET_PRICE)
  }
  const run: Run = { events: [], upstreams: [] }
  const trajectory: TrajectoryLogger = {
    record: (event) => run.events.push(event),
    start_span: (name) => name,
    end_span: () => {},
  }
  const pending: Array<Promise<void>> = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init): Promise<Response> => {
    const response = await original(input, init)
    const index = pending.length
    pending.push(
      read_upstream(response.clone()).then((upstream) => {
        run.upstreams[index] = upstream
      }),
    )
    return response
  }
  const provider_options = routing_options(c, `fascicle-live-cache-${randomUUID()}`)
  const { tool, ledger } = make_tool()
  try {
    run.result = await engine.generate({
      provider: c.provider,
      model: c.model,
      system: SYSTEM,
      prompt: PROMPT,
      tools: [tool],
      max_steps: 5,
      trajectory,
      ...(cache === undefined ? {} : { cache }),
      ...(provider_options === undefined ? {} : { provider_options }),
    })
  } catch (err: unknown) {
    run.error = err
  } finally {
    globalThis.fetch = original
    await Promise.all(pending)
    await engine.dispose()
  }
  const answer = run.result?.content.replace(/\D/g, '') ?? ''
  const expected = String(ledger.drawn.reduce((sum, n) => sum + n, 0))
  say(`${c.label}: answer ${answer === expected ? 'matches' : `is ${answer}, expected ${expected}`}`)
  return run
}

/** Print one line of a case's report. */
function say(line: string): void {
  // oxlint-disable-next-line no-console
  console.info(line)
}

/** A thrown value as one short line, so a provider's error body fits a summary. */
function one_line(err: unknown): string {
  const text = err instanceof Error ? err.message : JSON.stringify(err)
  return text.replace(/\s+/g, ' ').slice(0, 240)
}

/** The run's hit ratio: every turn's cache reads over every turn's input. */
function run_ratio(result: GenerateResult | undefined): string {
  const input = result?.usage.input_tokens ?? 0
  const read = result?.usage.cached_input_tokens ?? 0
  return input > 0 ? (read / input).toFixed(3) : 'n/a'
}

/** Print one line per turn: its usage, its ratio, and the upstream that served it. */
function print_turns(label: string, run: Run): void {
  const ratios = run.events.filter((e) => e.kind === 'response_received').map((e) => e['cache_hit_ratio'])
  for (const [index, step] of (run.result?.steps ?? []).entries()) {
    const u = step.usage
    const ratio = ratios[index]
    say(
      `${label} turn ${String(index + 1)}: input ${String(u.input_tokens)}, read ${String(u.cached_input_tokens ?? 0)}, ` +
        `wrote ${String(u.cache_write_tokens ?? 0)}, ratio ${typeof ratio === 'number' ? ratio.toFixed(3) : 'none'}, ` +
        `upstream ${run.upstreams[index] ?? 'unknown'}`,
    )
  }
}

/** The run's cost, for the line that compares a cached run with an uncached one. */
function cost_of(run: Run): string {
  const total = run.result?.cost?.total_usd
  return total === undefined ? 'no cost' : `$${total.toFixed(5)}`
}

/**
 * Assert what a cached Claude loop shows: a write on the first turn, reads on
 * the next two, and no `cache_miss`.
 */
function expect_cached(label: string, run: Run): void {
  if (run.error !== undefined) say(`${label}: failed: ${one_line(run.error)}`)
  expect(run.error).toBeUndefined()
  const steps = run.result?.steps ?? []
  expect(steps.length).toBeGreaterThanOrEqual(3)
  expect(steps[0]?.usage.cache_write_tokens ?? 0).toBeGreaterThan(0)
  expect(steps[1]?.usage.cached_input_tokens ?? 0).toBeGreaterThan(0)
  expect(steps[2]?.usage.cached_input_tokens ?? 0).toBeGreaterThan(0)
  expect(run.events.filter((e) => e.kind === 'cache_miss')).toStrictEqual([])
}

/** Run a Claude case cached by default, then the same loop with cache 'off', and compare. */
async function run_claude_case(c: LoopCase): Promise<void> {
  const cached = await run_loop(c, undefined)
  print_turns(c.label, cached)
  const off = await run_loop(c, 'off')
  say(
    `${c.label}: hit ratio ${run_ratio(cached.result)}, cost ${cost_of(cached)} cached against ${cost_of(off)} with cache 'off'`,
  )
  expect_cached(c.label, cached)
}

describe.skipIf(!(live && openrouter_key.length > 0))('live cache: anthropic native via OpenRouter', () => {
  it(
    'writes the cache on the first turn and reads it on the next two',
    async () => {
      await run_claude_case({
        label: 'anthropic native (openrouter)',
        provider: 'anthropic',
        api_key: openrouter_key,
        base_url: OPENROUTER_BASE_URL,
        model: OPENROUTER_MODEL,
        routed: true,
      })
    },
    TIMEOUT_MS,
  )
})

describe.skipIf(!(live && anthropic_key.length > 0))('live cache: anthropic native, direct', () => {
  it(
    'writes the cache on the first turn and reads it on the next two',
    async () => {
      await run_claude_case({
        label: 'anthropic native (api)',
        provider: 'anthropic',
        api_key: anthropic_key,
        model: API_MODEL,
        routed: false,
      })
    },
    TIMEOUT_MS,
  )
})

describe.skipIf(!(live && openrouter_key.length > 0))('live cache: openrouter native', () => {
  it(
    "caches a Claude loop when the call sets cache: '5m'",
    async () => {
      const c: LoopCase = {
        label: 'openrouter native (claude)',
        provider: 'openrouter',
        api_key: openrouter_key,
        model: OPENROUTER_MODEL,
        routed: true,
      }
      const run = await run_loop(c, '5m')
      print_turns(c.label, run)
      say(`${c.label}: hit ratio ${run_ratio(run.result)}, cost ${cost_of(run)}`)
      expect_cached(c.label, run)
    },
    TIMEOUT_MS,
  )

  it(
    "reports what OpenRouter does with cache: '5m' on a model from another vendor",
    async () => {
      const c: LoopCase = {
        label: `openrouter native (${OTHER_MODEL})`,
        provider: 'openrouter',
        api_key: openrouter_key,
        model: OTHER_MODEL,
        routed: false,
      }
      const run = await run_loop(c, '5m')
      if (run.error === undefined) {
        print_turns(c.label, run)
        say(`${c.label}: OpenRouter ignored the field; hit ratio ${run_ratio(run.result)}, cost ${cost_of(run)}`)
      } else {
        const status = field(run.error, 'status')
        const shown = typeof status === 'number' ? `status ${String(status)}` : 'no status'
        say(`${c.label}: OpenRouter refused the request (${shown}): ${one_line(run.error)}`)
      }
    },
    TIMEOUT_MS,
  )
})
