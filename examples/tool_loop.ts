/**
 * tool_loop: let the model call a tool and feed the result back.
 *
 * Registers a single `get_weather` tool that hits wttr.in. The engine runs
 * the tool-calling loop: model decides to call the tool, engine invokes the
 * `execute` closure, the result is fed back, model produces a final answer.
 *
 * Uses the `anthropic` provider so the execute closure actually runs. Under
 * the `claude_cli` provider, `execute` tools with `tool_bridge: 'allowlist_only'`
 * are dropped in favor of the CLI's own built-in tools — a different pattern.
 *
 * Prereqs:
 *   ANTHROPIC_API_KEY exported in your environment.
 *
 * Run directly:
 *   pnpm exec tsx examples/tool_loop.ts
 *   pnpm exec tsx examples/tool_loop.ts "What is the temperature in Oslo?"
 */

import { z } from 'zod'

import {
  create_engine,
  model_step,
  run,
  type Tool,
} from 'fascicle'

const api_key = process.env['ANTHROPIC_API_KEY'] ?? ''
const is_main = import.meta.url === `file://${process.argv[1] ?? ''}`

if (is_main && api_key.length === 0) {
  console.error('ANTHROPIC_API_KEY is not set')
  process.exit(1)
}

const engine = create_engine({
  providers: { anthropic: { api_key } },
  defaults: {
    model: 'sonnet',
    system: 'You have a weather tool. Use it when asked about weather. Reply in one sentence.',
  },
})

const weather_response = z.object({
  current_condition: z
    .array(z.object({ temp_C: z.string() }))
    .min(1),
})

const weather_input = z.object({ city: z.string() })

const get_weather: Tool = {
  name: 'get_weather',
  description: 'Look up the current temperature in Celsius for a city.',
  input_schema: weather_input,
  execute: async (raw, ctx) => {
    const { city } = weather_input.parse(raw)
    const res = await fetch(
      `https://wttr.in/${encodeURIComponent(city)}?format=j1`,
      { signal: ctx.abort },
    )
    if (!res.ok) throw new Error(`wttr.in ${String(res.status)}`)
    const body = weather_response.parse(await res.json())
    return { temp_c: Number(body.current_condition[0]?.temp_C ?? 'NaN') }
  },
}

// `model_step`: the engine runs the whole tool loop internally, so the step's
// output is the model's final text. Reach for `model_call` when the caller
// needs the envelope around it (which tools ran, usage, finish reason).
const ask = model_step({
  engine,
  tools: [get_weather],
  max_steps: 4,
})

export async function run_tool_loop(
  input = 'What is the current temperature in Vancouver?',
): Promise<{ readonly input: string; readonly output: string }> {
  const output = await run(ask, input, { install_signal_handlers: false })
  return { input, output }
}

if (is_main) {
  const argv_input = process.argv.slice(2).join(' ')
  const chosen = argv_input.length > 0 ? argv_input : undefined
  run_tool_loop(chosen)
    .then(({ input, output }) => {
      console.log(`input:  ${input}`)
      console.log(`output: ${output}`)
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
    .finally(() => {
      void engine.dispose()
    })
}
