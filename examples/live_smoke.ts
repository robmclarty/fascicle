/**
 * live_smoke: the manual release gate against real provider wires (V-P3.8,
 * step-12 final gate).
 *
 * Runs one tool-loop flow, streamed and non-streamed, across the three native
 * transports the native-expansion build shipped:
 *
 *   - openrouter  native   — hosted OpenAI-compatible chat/completions (the
 *                            step-6 gate, re-run here).
 *   - ollama      native   — the daemon's own /api/chat NDJSON endpoint (D2),
 *                            NOT the /v1 compat tail.
 *   - lmstudio    native   — LM Studio's OpenAI-compatible server (D10 tolerant
 *                            usage), on the raw-HTTP transport.
 *
 * The tool itself is a deterministic in-memory lookup, so the only network
 * under test is the provider wire: request mapping, the tool-call round trip,
 * stream chunk shapes, and usage/cost accounting. Live network keeps this out
 * of the test suite (constraint C5); re-run it manually after any provider-seam
 * change.
 *
 * Each backend is availability-gated: a backend whose key is absent or whose
 * daemon is unreachable is SKIPPED and reported not-run, never a failure — the
 * gate is "green where backends are available." The process exits non-zero only
 * if a backend that actually ran had a failing cell.
 *
 * Prereqs (any subset; missing ones are skipped):
 *   OPENROUTER_API_KEY exported, or set in the root .env (see .env.example).
 *   An Ollama daemon at SMOKE_OLLAMA_BASE_URL with a tool-capable model pulled.
 *   An LM Studio server at SMOKE_LMSTUDIO_BASE_URL with a tool-capable model.
 *
 * Run directly:
 *   pnpm exec tsx --env-file=.env examples/live_smoke.ts
 *
 * Overrides:
 *   SMOKE_ONLY                 comma list of {openrouter,ollama,lmstudio}
 *   SMOKE_OPENROUTER_MODEL     (default: openai/gpt-4o-mini)
 *   SMOKE_OPENROUTER_TRANSPORT (native | ai_sdk; default: native)
 *   SMOKE_OLLAMA_BASE_URL      (default: http://localhost:11434)
 *   SMOKE_OLLAMA_MODEL         (default: qwen3.6:latest)
 *   SMOKE_LMSTUDIO_BASE_URL    (default: http://localhost:1234/v1)
 *   SMOKE_LMSTUDIO_MODEL       (default: qwen/qwen3-4b)
 *   SMOKE_LMSTUDIO_TRANSPORT   (native | ai_sdk; default: native)
 */

import { z } from 'zod'

import {
  create_engine,
  model_call,
  run,
  type GenerateResult,
  type ProviderConfigMap,
  type StreamChunk,
  type Tool,
} from 'fascicle'

type SmokeTransport = 'ai_sdk' | 'native'
type ProviderName = 'openrouter' | 'ollama' | 'lmstudio'

function parse_transport(raw: string | undefined, fallback: SmokeTransport): SmokeTransport {
  return raw === 'ai_sdk' || raw === 'native' ? raw : fallback
}

const api_key = process.env['OPENROUTER_API_KEY'] ?? ''
const openrouter_model = process.env['SMOKE_OPENROUTER_MODEL'] ?? 'openai/gpt-4o-mini'
const openrouter_transport = parse_transport(process.env['SMOKE_OPENROUTER_TRANSPORT'], 'native')
const ollama_base_url = process.env['SMOKE_OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
const ollama_model = process.env['SMOKE_OLLAMA_MODEL'] ?? 'qwen3.6:latest'
// Ollama's native leg is the /api/chat path by definition (D2); transport is
// fixed, unlike the openrouter/lmstudio legs which the ai_sdk flip can re-run.
const ollama_transport: SmokeTransport = 'native'
const lmstudio_base_url = process.env['SMOKE_LMSTUDIO_BASE_URL'] ?? 'http://localhost:1234/v1'
const lmstudio_model = process.env['SMOKE_LMSTUDIO_MODEL'] ?? 'qwen/qwen3-4b'
const lmstudio_transport = parse_transport(process.env['SMOKE_LMSTUDIO_TRANSPORT'], 'native')

const only = (process.env['SMOKE_ONLY'] ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0)

const is_main = import.meta.url === `file://${process.argv[1] ?? ''}`

const PROMPT = 'What is the current temperature in Vancouver?'
const EXPECTED_TEMP_C = 11

const weather_input = z.object({ city: z.string() })

const get_weather: Tool = {
  name: 'get_weather',
  description: 'Look up the current temperature in Celsius for a city.',
  input_schema: weather_input,
  execute: (raw) => {
    const { city } = weather_input.parse(raw)
    return {
      temp_c: city.toLowerCase().includes('vancouver') ? EXPECTED_TEMP_C : 12,
    }
  },
}

type Availability = { readonly ok: true } | { readonly ok: false; readonly reason: string }

type Backend = {
  readonly label: string
  readonly provider: ProviderName
  readonly model: string
  readonly probe: () => Promise<Availability>
}

// A daemon probe: any HTTP response (even 4xx) proves the server is up; only a
// transport-level throw (connection refused, DNS, timeout) means not-run.
async function probe_http(url: string): Promise<Availability> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) })
    return { ok: true }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `${url} unreachable (${reason})` }
  }
}

const ALL_BACKENDS: readonly Backend[] = [
  {
    label: `openrouter (${openrouter_transport})`,
    provider: 'openrouter',
    model: openrouter_model,
    probe: () =>
      Promise.resolve(
        api_key.length > 0 ? { ok: true } : { ok: false, reason: 'OPENROUTER_API_KEY not set' },
      ),
  },
  {
    label: 'ollama (native /api/chat)',
    provider: 'ollama',
    model: ollama_model,
    probe: () => probe_http(`${ollama_base_url.replace(/\/+$/, '')}/api/tags`),
  },
  {
    label: `lmstudio (${lmstudio_transport})`,
    provider: 'lmstudio',
    model: lmstudio_model,
    probe: () => probe_http(`${lmstudio_base_url.replace(/\/+$/, '')}/models`),
  },
]

const SELECTED: readonly Backend[] = ALL_BACKENDS.filter(
  (backend) => only.length === 0 || only.includes(backend.provider),
)

export type SmokeCell = {
  readonly backend: string
  readonly model: string
  readonly streamed: boolean
  readonly failures: readonly string[]
  readonly result: GenerateResult
  readonly chunk_kinds: Readonly<Record<string, number>>
}

export type SmokeSkip = {
  readonly backend: string
  readonly reason: string
}

function as_stream_chunk(value: unknown): StreamChunk | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (typeof Reflect.get(value, 'kind') !== 'string') return undefined
  // model_call only records real StreamChunks under `chunk` on model_chunk
  // trajectory events, so narrowing on `kind` is sound.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as StreamChunk
}

async function run_cell(
  engine: ReturnType<typeof create_engine>,
  backend: Backend,
  streamed: boolean,
): Promise<SmokeCell> {
  const flow = model_call({
    engine,
    provider: backend.provider,
    model: backend.model,
    tools: [get_weather],
    max_steps: 4,
  })

  const chunks: StreamChunk[] = []
  let result: GenerateResult
  if (streamed) {
    const handle = run.stream(flow, PROMPT, { install_signal_handlers: false })
    const reader = (async (): Promise<void> => {
      for await (const event of handle.events) {
        if (event.kind !== 'model_chunk') continue
        const chunk = as_stream_chunk(event['chunk'])
        if (chunk !== undefined) chunks.push(chunk)
      }
    })()
    result = await handle.result
    await reader
  } else {
    result = await run(flow, PROMPT, { install_signal_handlers: false })
  }

  const chunk_kinds: Record<string, number> = {}
  for (const chunk of chunks) {
    chunk_kinds[chunk.kind] = (chunk_kinds[chunk.kind] ?? 0) + 1
  }

  return {
    backend: backend.label,
    model: backend.model,
    streamed,
    failures: check_cell(backend, streamed, result, chunks),
    result,
    chunk_kinds,
  }
}

function check_cell(
  backend: Backend,
  streamed: boolean,
  result: GenerateResult,
  chunks: readonly StreamChunk[],
): string[] {
  const failures: string[] = []

  const weather_call = result.tool_calls.find(
    (call) => call.name === 'get_weather' && call.error === undefined,
  )
  if (weather_call === undefined) {
    failures.push('no successful get_weather tool call recorded')
  } else {
    const output = z.object({ temp_c: z.number() }).safeParse(weather_call.output)
    if (!output.success || output.data.temp_c !== EXPECTED_TEMP_C) {
      failures.push(`tool output mismatch: ${JSON.stringify(weather_call.output)}`)
    }
  }

  if (typeof result.content !== 'string' || result.content.length === 0) {
    failures.push('final content is not a non-empty string')
  }
  if (result.finish_reason !== 'stop') {
    failures.push(`finish_reason is ${result.finish_reason}, expected stop`)
  }
  if (result.usage.input_tokens <= 0 || result.usage.output_tokens <= 0) {
    failures.push(`usage not recorded: ${JSON.stringify(result.usage)}`)
  }
  if (result.cost === undefined) {
    failures.push('cost not recorded')
  } else if (backend.provider === 'openrouter' && result.cost.total_usd <= 0) {
    failures.push('openrouter cost is zero; pricing key likely missed')
  }

  if (streamed) {
    if (!chunks.some((chunk) => chunk.kind === 'text')) {
      failures.push('no text chunks streamed')
    }
    if (!chunks.some((chunk) => chunk.kind === 'tool_call_end')) {
      failures.push('no tool_call_end chunk streamed')
    }
    if (!chunks.some((chunk) => chunk.kind === 'finish')) {
      failures.push('no finish chunk streamed')
    }
    for (const step of result.steps) {
      const assembled = chunks
        .filter(
          (chunk): chunk is Extract<StreamChunk, { kind: 'text' }> =>
            chunk.kind === 'text' && chunk.step_index === step.index,
        )
        .map((chunk) => chunk.text)
        .join('')
      if (assembled !== step.text) {
        failures.push(
          `step ${String(step.index)} streamed text != step record text ` +
            `(${JSON.stringify(assembled)} vs ${JSON.stringify(step.text)})`,
        )
      }
    }
  }

  return failures
}

export async function run_live_smoke(): Promise<{
  readonly cells: readonly SmokeCell[]
  readonly skipped: readonly SmokeSkip[]
  readonly ok: boolean
}> {
  const available: Backend[] = []
  const skipped: SmokeSkip[] = []
  for (const backend of SELECTED) {
    const status = await backend.probe()
    if (status.ok) {
      available.push(backend)
    } else {
      skipped.push({ backend: backend.label, reason: status.reason })
    }
  }

  // create_engine validates every configured provider eagerly, so only wire up
  // the backends this invocation will actually run. OpenRouter models have no
  // DEFAULT_PRICING entries, so register reference rates (gpt-4o-mini's) for
  // whichever model runs; the point is exercising the cost pipeline end to end,
  // and CostBreakdown is marked is_estimate regardless. Local providers
  // (ollama, lmstudio) are FREE_PROVIDERS: a zero-cost estimate, no key needed.
  const has = (provider: ProviderName): boolean => available.some((b) => b.provider === provider)
  const providers: ProviderConfigMap = {
    ...(has('openrouter') ? { openrouter: { api_key, transport: openrouter_transport } } : {}),
    ...(has('ollama') ? { ollama: { base_url: ollama_base_url, transport: ollama_transport } } : {}),
    ...(has('lmstudio')
      ? { lmstudio: { base_url: lmstudio_base_url, transport: lmstudio_transport } }
      : {}),
  }

  const engine = create_engine({
    providers,
    pricing: {
      [`openrouter:${openrouter_model}`]: {
        input_per_million: 0.15,
        output_per_million: 0.6,
        cached_input_per_million: 0.075,
      },
    },
    defaults: {
      system:
        'You have a get_weather tool. Use it when asked about weather. Reply in one sentence.',
    },
  })

  try {
    const cells: SmokeCell[] = []
    for (const backend of available) {
      for (const streamed of [false, true]) {
        cells.push(await run_cell(engine, backend, streamed))
      }
    }
    const ok = cells.length > 0 && cells.every((cell) => cell.failures.length === 0)
    return { cells, skipped, ok }
  } finally {
    await engine.dispose()
  }
}

function print_cell(cell: SmokeCell): void {
  const mode = cell.streamed ? 'streamed' : 'non-streamed'
  const verdict = cell.failures.length === 0 ? 'PASS' : 'FAIL'
  console.log(`\n[${verdict}] ${cell.backend} (${cell.model}) ${mode}`)
  console.log(`  content:       ${JSON.stringify(cell.result.content)}`)
  console.log(
    `  tool_calls:    ${JSON.stringify(
      cell.result.tool_calls.map((call) => ({
        name: call.name,
        input: call.input,
        output: call.output,
      })),
    )}`,
  )
  console.log(`  finish_reason: ${cell.result.finish_reason}`)
  console.log(`  usage:         ${JSON.stringify(cell.result.usage)}`)
  console.log(`  cost:          ${JSON.stringify(cell.result.cost)}`)
  if (cell.streamed) {
    console.log(`  chunk kinds:   ${JSON.stringify(cell.chunk_kinds)}`)
  }
  for (const failure of cell.failures) {
    console.log(`  FAILURE: ${failure}`)
  }
}

if (is_main) {
  run_live_smoke()
    .then(({ cells, skipped, ok }) => {
      for (const cell of cells) print_cell(cell)
      for (const skip of skipped) {
        console.log(`\n[SKIP] ${skip.backend} — not run: ${skip.reason}`)
      }
      if (cells.length === 0) {
        console.log('\nsmoke: no backends available (nothing run)')
      } else {
        console.log(`\nsmoke: ${ok ? 'all run cells green' : 'FAILURES PRESENT'}`)
      }
      process.exitCode = ok ? 0 : 1
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exitCode = 1
    })
}
