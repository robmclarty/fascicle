/**
 * Opt-in live reasoning check.
 *
 * Runs a three-step tool loop (two dependent tool calls, then the answer),
 * streamed, on the models and transports where reasoning has to survive a tool
 * loop, with effort unset and with `'medium'`. The mocked suite cannot see
 * this: whether a provider streams its reasoning, whether the next request
 * carries it back, and whether the provider accepts the effort field are all
 * facts about a live wire. Run it before a change to the reasoning path and
 * again after, and compare the printed lines.
 *
 *   LIVE_TESTS=1 OPENROUTER_API_KEY=... pnpm exec vitest run src/engine/__tests__/live/live_reasoning.test.ts
 *
 * Only OPENROUTER_API_KEY is needed. The two `anthropic` cases reach Claude
 * through OpenRouter's Anthropic-compatible Messages endpoint, which takes the
 * `x-api-key` header both Anthropic transports send. Which upstream serves a
 * step is OpenRouter's call and can change between steps, so every case
 * records it. Set LIVE_REASONING_PIN to an upstream name to pin the native
 * cases to it; the `ai_sdk` case cannot pin, because the SDK strips options it
 * does not know.
 *
 * The tools hand back numbers the model cannot guess and has to compute with,
 * fresh on every run, and the second tool takes a value worked out from the
 * first one's result. Adaptive thinking skips reasoning on anything a model
 * already knows, so a fixed question would pass while exercising nothing. A
 * case whose turns before a tool call carried no reasoning is reported as not
 * exercised (skipped), never as passing.
 *
 * The fetch tap sees the wire, so "carried back" means the next request held
 * `reasoning_details` or a thinking block on an assistant message. It reads
 * request bodies in memory and never saves them. It saves each response
 * stream under research/live/ (gitignored) as a fixture source; a response
 * holds no credential.
 */

import { randomInt } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { create_engine } from '../../create_engine.js'
import type { EffortLevel, GenerateResult, StreamChunk, Tool } from '../../types.js'

const live = process.env['LIVE_TESTS'] === '1'
const api_key = process.env['OPENROUTER_API_KEY'] ?? ''
const enabled = live && api_key.length > 0
const pin = process.env['LIVE_REASONING_PIN'] ?? ''

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
const SAVE_DIR = fileURLToPath(new URL('../../../../research/live/', import.meta.url))
const TIMEOUT_MS = 240_000
const EXPECTED_STEPS = 3
const EXPECTED_TOOL_CALLS = 2

type LiveCase = {
  readonly id: string
  readonly provider: 'openrouter' | 'anthropic'
  readonly transport: 'native' | 'ai_sdk'
  readonly model: string
}

const CASES: ReadonlyArray<LiveCase> = [
  { id: 'or-claude', provider: 'openrouter', transport: 'native', model: 'anthropic/claude-sonnet-5.5' },
  { id: 'or-gemini', provider: 'openrouter', transport: 'native', model: 'google/gemini-3.8-flash' },
  { id: 'or-gpt', provider: 'openrouter', transport: 'native', model: 'openai/gpt-5.5' },
  { id: 'anthropic-native', provider: 'anthropic', transport: 'native', model: 'anthropic/claude-sonnet-5.5' },
  { id: 'anthropic-ai-sdk', provider: 'anthropic', transport: 'ai_sdk', model: 'anthropic/claude-sonnet-5.5' },
]

const EFFORTS: ReadonlyArray<EffortLevel | undefined> = [undefined, 'medium']

const PROMPT = [
  'You have two tools. Work in this order and do not skip a step.',
  '1. Call get_pair to get the integers a and b.',
  '2. Work out k = (a * b) mod 1000 yourself, then call get_modulus with that k. It returns m.',
  '3. Reply with only the number (k * m + a) mod 9973, as digits.',
  'Think the arithmetic through before you call get_modulus and again before you answer.',
].join('\n')

type Ledger = { a: number; b: number; k?: number; m?: number }

type TapRecord = {
  readonly index: number
  readonly status: number
  readonly carried_reasoning: boolean
  reasoning_in_response: boolean
  upstream: string
}

type Tap = {
  readonly records: TapRecord[]
  readonly settle: () => Promise<void>
  readonly restore: () => void
}

/**
 * Read one field off a value of unknown shape, so the wire checks below stay
 * free of casts.
 */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/**
 * Build the two tools and the ledger they write to. The ledger is how the
 * test learns the numbers the model was given, so it can mark the answer
 * without trusting the model's own account of them.
 */
function make_tools(): { tools: Tool[]; ledger: Ledger } {
  const ledger: Ledger = { a: randomInt(100, 1000), b: randomInt(100, 1000) }
  const m = randomInt(101, 997)
  const get_pair: Tool = {
    name: 'get_pair',
    description: 'Returns two integers, a and b. Takes no input.',
    input_schema: z.object({}),
    execute: () => ({ a: ledger.a, b: ledger.b }),
  }
  const get_modulus: Tool = {
    name: 'get_modulus',
    description: 'Returns the modulus m for the key k, where k = (a * b) mod 1000 from get_pair.',
    input_schema: z.object({ k: z.number().int() }),
    execute: (input) => {
      ledger.k = z.object({ k: z.number() }).parse(input).k
      ledger.m = m
      return { m }
    },
  }
  return { tools: [get_pair, get_modulus], ledger }
}

/**
 * Whether one assistant message carries reasoning in the form either wire
 * accepts: OpenRouter's `reasoning_details`, its older `reasoning` string, or
 * an Anthropic thinking block.
 */
function message_has_reasoning(message: unknown): boolean {
  const details = field(message, 'reasoning_details')
  if (Array.isArray(details) && details.length > 0) return true
  const reasoning = field(message, 'reasoning')
  if (typeof reasoning === 'string' && reasoning.length > 0) return true
  const content = field(message, 'content')
  if (!Array.isArray(content)) return false
  return content.some((block) => {
    const type = field(block, 'type')
    return type === 'thinking' || type === 'redacted_thinking' || type === 'reasoning'
  })
}

/**
 * Whether a request body holds an assistant message that carries reasoning,
 * which is what a loop sends when it hands the previous turn's reasoning back.
 */
function request_carries_reasoning(body: unknown): boolean {
  if (typeof body !== 'string') return false
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }
  const messages = field(parsed, 'messages')
  if (!Array.isArray(messages)) return false
  return messages.some((m) => field(m, 'role') === 'assistant' && message_has_reasoning(m))
}

const REASONING_IN_STREAM = [
  /"reasoning_details"\s*:\s*\[\s*\{/,
  /"reasoning"\s*:\s*"[^"]/,
  /"type"\s*:\s*"(?:redacted_)?thinking"/,
  /"thinking_delta"/,
]

/**
 * Whether a raw response stream held any reasoning, in either wire's form.
 */
function response_has_reasoning(raw: string): boolean {
  return REASONING_IN_STREAM.some((pattern) => pattern.test(raw))
}

/**
 * The upstream a response says served it: the header when OpenRouter sets
 * one, else the first `provider` field in the stream.
 */
function read_upstream(response: Response, raw: string): string {
  const header = response.headers.get('x-openrouter-provider')
  if (header !== null && header.length > 0) return header
  const found = /"provider"\s*:\s*"([^"]+)"/.exec(raw)
  return found?.[1] ?? 'unknown'
}

/**
 * Read a cloned response to its end, fill in what it shows, and save the raw
 * stream. A body the consumer cancelled reads as an error here, which is
 * recorded as nothing seen rather than failing the case.
 */
async function drain_copy(copy: Response, record: TapRecord, label: string): Promise<void> {
  let raw = ''
  try {
    raw = await copy.text()
  } catch {
    return
  }
  record.reasoning_in_response = response_has_reasoning(raw)
  record.upstream = read_upstream(copy, raw)
  mkdirSync(SAVE_DIR, { recursive: true })
  writeFileSync(`${SAVE_DIR}${label}-step${String(record.index)}.sse`, raw)
}

/**
 * Wrap the global fetch the engine's transports call, recording each
 * OpenRouter request and tee-ing its response. The wrapper hands the caller
 * the original response untouched.
 */
function install_tap(label: string): Tap {
  const original = globalThis.fetch
  const records: TapRecord[] = []
  const pending: Array<Promise<void>> = []
  globalThis.fetch = async (input, init): Promise<Response> => {
    const response = await original(input, init)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes('openrouter.ai')) return response
    const record: TapRecord = {
      index: records.length,
      status: response.status,
      carried_reasoning: request_carries_reasoning(init?.body),
      reasoning_in_response: false,
      upstream: 'unknown',
    }
    records.push(record)
    pending.push(drain_copy(response.clone(), record, label))
    return response
  }
  return {
    records,
    settle: async () => {
      await Promise.all(pending)
    },
    restore: () => {
      globalThis.fetch = original
    },
  }
}

/**
 * The upstream pin, when LIVE_REASONING_PIN is set and the transport can
 * carry it. OpenRouter reads `provider` from the request body.
 */
function pin_options(c: LiveCase): Record<string, unknown> | undefined {
  if (pin.length === 0 || c.transport === 'ai_sdk') return undefined
  return { [c.provider]: { provider: { order: [pin], allow_fallbacks: false } } }
}

/**
 * Mark the model's answer against the numbers the tools gave it. Reported,
 * not asserted: a wrong sum says nothing about reasoning.
 */
function answer_matches(content: string, ledger: Ledger): boolean {
  if (ledger.k === undefined || ledger.m === undefined) return false
  const expected = (ledger.k * ledger.m + ledger.a) % 9973
  return content.replace(/\D/g, '') === String(expected)
}

/**
 * The sum of the charges OpenRouter reported on each step, a BYOK step's
 * upstream cost included, the way the engine counts a BYOK total. Undefined
 * when no step reported one, which is every case off the openrouter provider.
 */
function reported_charges(result: GenerateResult | undefined): number | undefined {
  let sum: number | undefined
  for (const step of result?.steps ?? []) {
    const reported = field(step.provider_reported, 'openrouter')
    const cost = field(reported, 'cost')
    if (typeof cost !== 'number') continue
    const upstream = field(field(reported, 'cost_details'), 'upstream_inference_cost')
    const byok = field(reported, 'is_byok') === true && typeof upstream === 'number' ? upstream : 0
    sum = (sum ?? 0) + (cost + byok)
  }
  return sum
}

/**
 * A thrown value as one short line, so a provider's multi-line error body
 * fits in the case's summary.
 */
function one_line(err: unknown): string {
  const text = err instanceof Error ? err.message : JSON.stringify(err)
  return text.replace(/\s+/g, ' ').slice(0, 240)
}

type Outcome = {
  result?: GenerateResult
  error?: unknown
  reasoning_chunks: number[]
}

/**
 * Run the loop once, streamed. A throw is kept as the outcome so the line for
 * the build log is printed before the case fails.
 */
async function run_loop(c: LiveCase, effort: EffortLevel | undefined, tools: Tool[]): Promise<Outcome> {
  const engine = create_engine({
    providers: {
      [c.provider]: {
        api_key,
        transport: c.transport,
        ...(c.provider === 'anthropic' ? { base_url: OPENROUTER_BASE_URL } : {}),
      },
    },
  })
  const outcome: Outcome = { reasoning_chunks: [] }
  const on_chunk = (chunk: StreamChunk): void => {
    if (chunk.kind !== 'reasoning') return
    outcome.reasoning_chunks[chunk.step_index] = (outcome.reasoning_chunks[chunk.step_index] ?? 0) + 1
  }
  const provider_options = pin_options(c)
  try {
    outcome.result = await engine.generate({
      provider: c.provider,
      model: c.model,
      prompt: PROMPT,
      tools,
      max_steps: 5,
      on_chunk,
      ...(effort === undefined ? {} : { effort }),
      ...(provider_options === undefined ? {} : { provider_options }),
    })
  } catch (err: unknown) {
    outcome.error = err
  }
  return outcome
}

/**
 * Whether a model reasoned before a tool call and so gave the round trip
 * something to carry. Turns before a tool call are every turn but the last.
 */
function round_trip_exercised(tap: Tap): boolean {
  return tap.records.slice(0, -1).some((r) => r.reasoning_in_response)
}

/**
 * One line for the build log: finished, error, which turns came back with
 * reasoning, whether each next request carried it back, the reasoning chunks
 * seen, output tokens per step, the upstream per step, and the call's cost
 * beside the charges OpenRouter reported for it.
 */
function summary_line(
  label: string,
  outcome: Outcome,
  tap: Tap,
  ledger: Ledger,
): string {
  const flag = (b: boolean): string => (b ? '1' : '0')
  const steps = outcome.result?.steps ?? []
  const error = outcome.error === undefined ? '-' : one_line(outcome.error)
  const parts = [
    `case=${label}`,
    `finished=${String(outcome.result !== undefined)}`,
    `steps=${String(steps.length)}`,
    `error=${error}`,
    `reasoned=[${tap.records.map((r) => flag(r.reasoning_in_response)).join(',')}]`,
    `carried_back=[${tap.records.map((r) => flag(r.carried_reasoning)).join(',')}]`,
    `reasoning_chunks=[${steps.map((_, i) => String(outcome.reasoning_chunks[i] ?? 0)).join(',')}]`,
    `output_tokens=[${steps.map((s) => String(s.usage.output_tokens)).join(',')}]`,
    `reasoning_tokens=[${steps.map((s) => String(s.usage.reasoning_tokens ?? 0)).join(',')}]`,
    `upstream=[${tap.records.map((r) => r.upstream).join(',')}]`,
    `cost_usd=${String(outcome.result?.cost?.total_usd ?? '-')}`,
    `reported_usd=${String(reported_charges(outcome.result) ?? '-')}`,
    `exercised=${String(round_trip_exercised(tap))}`,
    `answer_ok=${String(outcome.result !== undefined && answer_matches(outcome.result.content, ledger))}`,
  ]
  return `live-reasoning ${parts.join(' ')}`
}

describe.skipIf(!enabled)('live reasoning check', () => {
  let tap: Tap | undefined

  afterEach(() => {
    tap?.restore()
    tap = undefined
  })

  for (const c of CASES) {
    describe(`${c.id}: ${c.provider} ${c.transport}, ${c.model}`, () => {
      for (const effort of EFFORTS) {
        const effort_name = effort ?? 'unset'
        it(
          `finishes a three-step tool loop with effort ${effort_name} and sends reasoning back`,
          async (ctx) => {
            const label = `${c.id}-${effort_name}`
            const active = install_tap(label)
            tap = active
            const { tools, ledger } = make_tools()

            const outcome = await run_loop(c, effort, tools)
            await active.settle()
            // The line is the build log's record, so it must reach the terminal
            // whether the case passes or fails.
            // oxlint-disable-next-line no-console
            console.info(summary_line(label, outcome, active, ledger))

            expect(outcome.error).toBeUndefined()
            const result = outcome.result
            expect(result?.finish_reason).toBe('stop')
            expect(result?.steps).toHaveLength(EXPECTED_STEPS)
            expect(result?.tool_calls).toHaveLength(EXPECTED_TOOL_CALLS)

            if (c.provider === 'openrouter') {
              const charged = reported_charges(result)
              expect(charged, 'no step reported what OpenRouter charged').toBeDefined()
              // The engine rounds a call's total to six places, and OpenRouter
              // can report a step to seven, so the sum is compared rounded.
              expect(result?.cost?.total_usd).toBe(Math.round((charged ?? Number.NaN) * 1e6) / 1e6)
            }

            active.records.forEach((record, i) => {
              if (i === 0) return
              const before = active.records[i - 1]
              if (before?.reasoning_in_response !== true) return
              expect(
                record.carried_reasoning,
                `request ${String(i)} dropped the reasoning turn ${String(i - 1)} returned`,
              ).toBe(true)
            })

            if (!round_trip_exercised(active)) {
              ctx.skip('round trip not exercised: no turn before a tool call came back with reasoning')
            }
          },
          TIMEOUT_MS,
        )
      }
    })
  }
})
