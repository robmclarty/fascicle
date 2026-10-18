/**
 * define_tool: typed tool inputs.
 *
 * The type half pins what the helper exists for: `execute` and
 * `needs_approval` see the type `input_schema` validates to, the result drops
 * into a `Tool[]` with no cast, and a hand-typed `Tool<i>` still can't. The
 * runtime half drives tools through the real engine path (create_engine ->
 * generate -> the tool loop) on a scripted native provider, through both
 * `model_step` and `engine.generate`, to show the cast's premise holds:
 * `execute` gets the validated value, and an input that fails validation never
 * reaches it.
 */

import { create_engine, define_tool, model_step, run } from 'fascicle'
import type { Tool } from 'fascicle'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ProviderFactory } from '../providers/types.js'
import type { TurnRequest, TurnResult } from '../types.js'

const PROVIDER = 'scripted'
const MODEL = 'scripted-1'

const weather_input = z.object({
  city: z.string(),
  units: z.enum(['c', 'f']).default('c'),
})

type TurnScript = ReadonlyArray<Pick<TurnResult, 'text' | 'tool_calls'>>

/**
 * A native provider that plays back one scripted turn per request, and
 * records each request so a test can read the tool results the loop fed back.
 */
function scripted_engine(script: TurnScript): {
  engine: ReturnType<typeof create_engine>
  requests: TurnRequest[]
} {
  const requests: TurnRequest[] = []
  const factory: ProviderFactory = () => ({
    kind: 'native',
    name: PROVIDER,
    invoke_turn: async (req) => {
      requests.push(req)
      const turn = script[requests.length - 1]
      if (turn === undefined) throw new Error(`no scripted turn for request ${String(requests.length)}`)
      return {
        ...turn,
        finish_reason: turn.tool_calls.length > 0 ? 'tool_calls' : 'stop',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
    supports: () => true,
  })
  const engine = create_engine({
    providers: { [PROVIDER]: {} },
    custom_providers: { [PROVIDER]: factory },
    defaults: { provider: PROVIDER, model: MODEL },
  })
  return { engine, requests }
}

describe('define_tool types', () => {
  it('types execute and needs_approval from input_schema', () => {
    const tool = define_tool({
      name: 'get_weather',
      description: 'Look up the weather for a city.',
      input_schema: weather_input,
      execute: ({ city, units }) => {
        const name: string = city
        const scale: 'c' | 'f' = units
        // @ts-expect-error city is a string, not a number
        const wrong: number = city
        return `${name} ${scale} ${String(wrong)}`
      },
      needs_approval: (input) => {
        // @ts-expect-error the schema has no country field
        const country: unknown = input.country
        return input.city.length > 0 && country === undefined
      },
    })
    const tools: Tool[] = [tool]
    expect(tools).toHaveLength(1)
  })

  it('is needed: a hand-typed Tool<i> does not widen to Tool', () => {
    const typed: Tool<{ city: string }> = {
      name: 'get_weather',
      description: 'Look up the weather for a city.',
      input_schema: z.object({ city: z.string() }),
      execute: ({ city }) => city,
    }
    // @ts-expect-error execute wants { city: string }, and a Tool's execute takes unknown
    const tools: Tool[] = [typed]
    expect(tools).toHaveLength(1)
  })

  it('returns the spec it was given', () => {
    const spec: Tool<z.output<typeof weather_input>> = {
      name: 'get_weather',
      description: 'Look up the weather for a city.',
      input_schema: weather_input,
      execute: ({ city }) => city,
      ends_turn: true,
    }
    expect(define_tool(spec)).toBe(spec)
  })
})

describe('define_tool through the engine', () => {
  it('runs in a model_step tool loop and hands execute the validated input', async () => {
    const seen: Array<z.output<typeof weather_input>> = []
    const get_weather = define_tool({
      name: 'get_weather',
      description: 'Look up the weather for a city.',
      input_schema: weather_input,
      execute: (input) => {
        seen.push(input)
        return { temp: 4, units: input.units, city: input.city.toUpperCase() }
      },
    })
    const { engine, requests } = scripted_engine([
      { text: '', tool_calls: [{ id: 'c1', name: 'get_weather', input: { city: 'Oslo' } }] },
      { text: 'It is 4 degrees in Oslo.', tool_calls: [] },
    ])

    const ask = model_step({ engine, tools: [get_weather], max_steps: 3 })
    const out = await run(ask, 'How warm is Oslo?', { install_signal_handlers: false })

    expect(out).toBe('It is 4 degrees in Oslo.')
    expect(seen).toStrictEqual([{ city: 'Oslo', units: 'c' }])
    const fed_back = requests[1]?.messages.find((m) => m.role === 'tool')
    expect(fed_back).toMatchObject({
      role: 'tool',
      tool_call_id: 'c1',
      name: 'get_weather',
      content: JSON.stringify({ temp: 4, units: 'c', city: 'OSLO' }),
    })
    await engine.dispose()
  })

  it('never runs execute or needs_approval on input that fails the schema', async () => {
    let calls = 0
    const get_weather = define_tool({
      name: 'get_weather',
      description: 'Look up the weather for a city.',
      input_schema: weather_input,
      needs_approval: () => {
        calls += 1
        return false
      },
      execute: ({ city }) => {
        calls += 1
        return city
      },
    })
    const { engine } = scripted_engine([
      { text: '', tool_calls: [{ id: 'c1', name: 'get_weather', input: { city: 42 } }] },
      { text: 'I could not look that up.', tool_calls: [] },
    ])

    const result = await engine.generate({ prompt: 'How warm is 42?', tools: [get_weather], max_steps: 3 })

    expect(calls).toBe(0)
    expect(result.content).toBe('I could not look that up.')
    expect(result.tool_calls).toHaveLength(1)
    expect(result.tool_calls[0]?.error?.message).toMatch(/^invalid tool input: /)
    await engine.dispose()
  })
})
