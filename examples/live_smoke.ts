/**
 * live_smoke: the manual release gate against real provider wires (V-P3.8).
 *
 * Runs the same tool-loop flow four ways: {openrouter, openai-compatible} x
 * {non-streamed, streamed}. The tool itself is a deterministic in-memory
 * lookup, so the only network under test is the provider wire: request
 * mapping, the tool-call round trip, stream chunk shapes, and usage/cost
 * accounting. Live network keeps this out of the test suite (constraint C5);
 * re-run it manually after any provider-seam change.
 *
 * The OpenAI-compatible leg uses the `lmstudio` provider (the
 * @ai-sdk/openai-compatible adapter) pointed at any OpenAI-compatible
 * server. The default base_url targets Ollama's compatibility endpoint;
 * LM Studio's own server is http://localhost:1234/v1.
 *
 * Prereqs:
 *   OPENROUTER_API_KEY exported, or set in the root .env (see .env.example).
 *   An OpenAI-compatible server running (default: Ollama at localhost:11434)
 *   with a tool-capable model pulled.
 *
 * Run directly:
 *   pnpm exec tsx --env-file=.env examples/live_smoke.ts
 *
 * Overrides:
 *   SMOKE_ONLY              (openrouter | compat; default: both backends)
 *   SMOKE_OPENROUTER_MODEL  (default: openai/gpt-4o-mini)
 *   SMOKE_COMPAT_BASE_URL   (default: http://localhost:11434/v1)
 *   SMOKE_COMPAT_MODEL      (default: qwen3:4b-instruct-2507-q4_K_M)
 */

import { z } from 'zod'

import {
  create_engine,
  model_call,
  run,
  type GenerateResult,
  type StreamChunk,
  type Tool,
} from 'fascicle'

const api_key = process.env['OPENROUTER_API_KEY'] ?? ''
const openrouter_model = process.env['SMOKE_OPENROUTER_MODEL'] ?? 'openai/gpt-4o-mini'
const compat_base_url =
  process.env['SMOKE_COMPAT_BASE_URL'] ?? 'http://localhost:11434/v1'
const compat_model =
  process.env['SMOKE_COMPAT_MODEL'] ?? 'qwen3:4b-instruct-2507-q4_K_M'

const only = process.env['SMOKE_ONLY']

const is_main = import.meta.url === `file://${process.argv[1] ?? ''}`

if (is_main && only !== 'compat' && api_key.length === 0) {
  console.error('OPENROUTER_API_KEY is not set (or run with SMOKE_ONLY=compat)')
  process.exit(1)
}

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

// create_engine validates every configured provider eagerly, so only wire up
// the backends this invocation will actually run. OpenRouter models have no
// DEFAULT_PRICING entries, so register reference rates (gpt-4o-mini's) for
// whichever model runs; the point is exercising the cost pipeline end to end,
// and CostBreakdown is marked is_estimate regardless.
const engine = create_engine({
  providers: {
    ...(only === 'compat' ? {} : { openrouter: { api_key } }),
    ...(only === 'openrouter' ? {} : { lmstudio: { base_url: compat_base_url } }),
  },
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

type Backend = {
  readonly label: string
  readonly provider: 'openrouter' | 'lmstudio'
  readonly model: string
}

const ALL_BACKENDS: readonly Backend[] = [
  { label: 'openrouter', provider: 'openrouter', model: openrouter_model },
  { label: 'openai-compatible', provider: 'lmstudio', model: compat_model },
]

const BACKENDS: readonly Backend[] = ALL_BACKENDS.filter(
  (backend) =>
    only === undefined ||
    (only === 'compat' ? backend.provider === 'lmstudio' : backend.provider === only),
)

export type SmokeCell = {
  readonly backend: string
  readonly model: string
  readonly streamed: boolean
  readonly failures: readonly string[]
  readonly result: GenerateResult
  readonly chunk_kinds: Readonly<Record<string, number>>
}

function as_stream_chunk(value: unknown): StreamChunk | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (typeof Reflect.get(value, 'kind') !== 'string') return undefined
  // model_call only records real StreamChunks under `chunk` on model_chunk
  // trajectory events, so narrowing on `kind` is sound.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as StreamChunk
}

async function run_cell(backend: Backend, streamed: boolean): Promise<SmokeCell> {
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
  readonly ok: boolean
}> {
  const cells: SmokeCell[] = []
  for (const backend of BACKENDS) {
    for (const streamed of [false, true]) {
      cells.push(await run_cell(backend, streamed))
    }
  }
  return { cells, ok: cells.every((cell) => cell.failures.length === 0) }
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
    .then(({ cells, ok }) => {
      for (const cell of cells) print_cell(cell)
      console.log(`\nsmoke: ${ok ? 'all cells green' : 'FAILURES PRESENT'}`)
      process.exitCode = ok ? 0 : 1
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exitCode = 1
    })
    .finally(() => {
      void engine.dispose()
    })
}
