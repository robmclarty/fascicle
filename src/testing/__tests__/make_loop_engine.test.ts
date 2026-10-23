import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import { define_tool, provider_error } from '#engine'
import type { Message, RetryPolicy, StreamChunk, Tool } from '#engine'
import { make_loop_engine } from '../make_loop_engine.js'

const NO_WAIT: RetryPolicy = { max_attempts: 2, initial_delay_ms: 0, max_delay_ms: 0, retry_on: ['provider_5xx'] }

/** A tool that echoes its city back, and records every input it ran on. */
function weather(ran: unknown[] = []): Tool {
  return define_tool({
    name: 'get_weather',
    description: 'Look up the weather for a city.',
    input_schema: z.object({ city: z.string() }),
    execute: (input) => {
      ran.push(input)
      return `sunny in ${input.city}`
    },
  })
}

/** A trajectory that keeps every event it is handed. */
function recorder(events: TrajectoryEvent[]): TrajectoryLogger {
  return {
    record: (event) => {
      events.push(event)
    },
    start_span: (name) => name,
    end_span: () => undefined,
  }
}

/** The tool messages a request carried, as id and content. */
function tool_results(messages: ReadonlyArray<Message>): Array<[string, string]> {
  return messages.flatMap((message) => (message.role === 'tool' ? [[message.tool_call_id, message.content]] : []))
}

describe('make_loop_engine', () => {
  it('ends on a string turn, with its text, a stop, and the default usage and model', async () => {
    const { engine, requests } = make_loop_engine(['all done'])
    const result = await engine.generate({ prompt: 'hi' })
    expect(result.content).toBe('all done')
    expect(result.finish_reason).toBe('stop')
    expect(result.usage).toEqual({ input_tokens: 40, output_tokens: 20 })
    expect(result.model_resolved).toEqual({ provider: 'loop', model_id: 'loop' })
    expect(requests.map((req) => req.model_id)).toEqual(['loop'])
  })

  it('runs an array turn through the real tool loop, naming each call by its turn and place', async () => {
    const ran: unknown[] = []
    const { engine, requests } = make_loop_engine([
      'thinking it over',
      [
        { name: 'get_weather', input: { city: 'Oslo' } },
        { name: 'get_weather', input: { city: 'Lima' } },
      ],
      'Oslo and Lima are sunny',
    ])
    await engine.generate({ prompt: 'first' })
    const result = await engine.generate({ prompt: 'weather?', tools: [weather(ran)] })
    expect(result.content).toBe('Oslo and Lima are sunny')
    expect(ran).toEqual([{ city: 'Oslo' }, { city: 'Lima' }])
    expect(result.tool_calls.map((call) => call.id)).toEqual(['call_1_0', 'call_1_1'])
    expect(result.steps.map((step) => step.finish_reason)).toEqual(['tool_calls', 'stop'])
    expect(tool_results(requests[2]?.messages ?? [])).toEqual([
      ['call_1_0', 'sunny in Oslo'],
      ['call_1_1', 'sunny in Lima'],
    ])
  })

  it('keeps the ids a turn gives its calls', async () => {
    const { engine } = make_loop_engine([[{ id: 'mine', name: 'get_weather', input: { city: 'Oslo' } }], 'ok'])
    const result = await engine.generate({ prompt: 'x', tools: [weather()] })
    expect(result.tool_calls.map((call) => call.id)).toEqual(['mine'])
  })

  it('plays an object turn field by field, its finish reason and usage passing through', async () => {
    const { engine, requests } = make_loop_engine([
      {
        text: 'checking',
        tool_calls: [{ name: 'get_weather', input: { city: 'Rome' } }],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
      { text: 'cut short', finish_reason: 'length', usage: { input_tokens: 9, output_tokens: 11 } },
    ])
    const result = await engine.generate({ prompt: 'x', tools: [weather()] })
    expect(result.content).toBe('cut short')
    expect(result.finish_reason).toBe('length')
    expect(result.steps.map((step) => [step.text, step.finish_reason, step.usage])).toEqual([
      ['checking', 'tool_calls', { input_tokens: 7, output_tokens: 3 }],
      ['cut short', 'length', { input_tokens: 9, output_tokens: 11 }],
    ])
    expect(requests[1]?.messages.at(-2)).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_call', id: 'call_0_0', name: 'get_weather', input: { city: 'Rome' } },
      ],
    })
  })

  it('reads text and calls off the content of a turn, and sends the content back as the assistant message', async () => {
    const content = [
      { type: 'reasoning' as const, text: 'the user wants weather', provider_options: { loop: { signature: 's' } } },
      { type: 'text' as const, text: 'let me ' },
      { type: 'text' as const, text: 'look' },
      { type: 'tool_call' as const, id: 'p1', name: 'get_weather', input: { city: 'Kyiv' } },
    ]
    const ran: unknown[] = []
    const { engine, requests } = make_loop_engine([{ content }, 'done'])
    const result = await engine.generate({ prompt: 'x', tools: [weather(ran)] })
    expect(ran).toEqual([{ city: 'Kyiv' }])
    expect(result.steps[0]?.text).toBe('let me look')
    expect(result.steps[0]?.finish_reason).toBe('tool_calls')
    expect(result.tool_calls.map((call) => call.id)).toEqual(['p1'])
    expect(requests[1]?.messages.at(-2)).toEqual({ role: 'assistant', content })
  })

  it('lets the explicit text and calls of a turn win over its content', async () => {
    const ran: unknown[] = []
    const { engine } = make_loop_engine([
      {
        text: 'spoken',
        tool_calls: [{ name: 'get_weather', input: { city: 'Baku' } }],
        content: [
          { type: 'text', text: 'ignored' },
          { type: 'tool_call', id: 'p1', name: 'get_weather', input: { city: 'Riga' } },
        ],
      },
      'done',
    ])
    const result = await engine.generate({ prompt: 'x', tools: [weather(ran)] })
    expect(result.steps[0]?.text).toBe('spoken')
    expect(ran).toEqual([{ city: 'Baku' }])
  })

  it('ends with a stop when the content of a turn holds no call, and with no text when it holds no text', async () => {
    const { engine } = make_loop_engine([{ content: [{ type: 'reasoning', text: 'hm' }] }])
    const result = await engine.generate({ prompt: 'x' })
    expect(result.finish_reason).toBe('stop')
    expect(result.content).toBe('')
  })

  it('streams each turn to on_chunk: its text, then each call opening and closing', async () => {
    const chunks: StreamChunk[] = []
    const { engine } = make_loop_engine([
      [{ name: 'get_weather', input: { city: 'Oslo' } }],
      { text: 'said', tool_calls: [] },
      'sunny',
    ])
    await engine.generate({
      prompt: 'x',
      tools: [weather()],
      on_chunk: (chunk) => {
        chunks.push(chunk)
      },
    })
    const played = chunks.filter((chunk) => ['text', 'tool_call_start', 'tool_call_end'].includes(chunk.kind))
    expect(played).toEqual([
      { kind: 'tool_call_start', id: 'call_0_0', name: 'get_weather', step_index: 0 },
      { kind: 'tool_call_end', id: 'call_0_0', input: { city: 'Oslo' }, step_index: 0 },
      { kind: 'text', text: 'said', step_index: 1 },
    ])
  })

  it('streams a final answer as one text chunk', async () => {
    const chunks: StreamChunk[] = []
    const { engine } = make_loop_engine(['sunny'])
    await engine.generate({
      prompt: 'x',
      on_chunk: (chunk) => {
        chunks.push(chunk)
      },
    })
    expect(chunks.filter((chunk) => chunk.kind === 'text')).toEqual([{ kind: 'text', text: 'sunny', step_index: 0 }])
  })

  it('takes a default model and usage from its options', async () => {
    const { engine, requests } = make_loop_engine(['a', { text: 'b', usage: { input_tokens: 1, output_tokens: 2 } }], {
      model_id: 'loop-large',
      usage: { input_tokens: 5, output_tokens: 6 },
    })
    const first = await engine.generate({ prompt: 'x' })
    const second = await engine.generate({ prompt: 'y' })
    expect(first.model_resolved).toEqual({ provider: 'loop', model_id: 'loop-large' })
    expect(first.usage).toEqual({ input_tokens: 5, output_tokens: 6 })
    expect(second.usage).toEqual({ input_tokens: 1, output_tokens: 2 })
    expect(requests.map((req) => req.model_id)).toEqual(['loop-large', 'loop-large'])
  })

  it('throws the plain Error of a turn once, with no retry and nothing streamed', async () => {
    const boom = new Error('boom')
    const chunks: StreamChunk[] = []
    const { engine, requests } = make_loop_engine([{ throw: boom, text: 'never sent' }, 'unreached'])
    const failure = await engine
      .generate({
        prompt: 'x',
        retry: NO_WAIT,
        on_chunk: (chunk) => {
          chunks.push(chunk)
        },
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      )
    expect(failure).toBe(boom)
    expect(requests).toHaveLength(1)
    expect(chunks.filter((chunk) => chunk.kind === 'text')).toEqual([])
  })

  it('retries a 503 the way it would a provider, the retry using up the next turn under the same step', async () => {
    const { engine, requests } = make_loop_engine([
      [{ name: 'get_weather', input: { city: 'Oslo' } }],
      { throw: new provider_error('overloaded', { status: 503 }) },
      'sunny',
    ])
    const result = await engine.generate({ prompt: 'x', tools: [weather()], retry: NO_WAIT })
    expect(result.content).toBe('sunny')
    expect(requests.map((req) => req.step_index)).toEqual([0, 1, 1])
  })

  it('throws once the script runs out, naming the turns scripted and the turn requested', async () => {
    const { engine, requests } = make_loop_engine(['only'])
    await engine.generate({ prompt: 'x' })
    await expect(engine.generate({ prompt: 'y' })).rejects.toThrow(
      'make_loop_engine: script exhausted: 1 turn(s) scripted, turn 2 requested',
    )
    await expect(engine.generate({ prompt: 'z' })).rejects.toThrow(
      'make_loop_engine: script exhausted: 1 turn(s) scripted, turn 3 requested',
    )
    expect(requests.map((req) => req.messages)).toEqual([
      [{ role: 'user', content: 'x' }],
      [{ role: 'user', content: 'y' }],
      [{ role: 'user', content: 'z' }],
    ])
  })

  it('keeps every request in order in a live array, the system prompt and tools included', async () => {
    const tool = weather()
    const { engine, requests } = make_loop_engine([[{ name: 'get_weather', input: { city: 'Oslo' } }], 'sunny'])
    const pending = engine.generate({ prompt: 'x', system: 'be brief', tools: [tool] })
    expect(requests).toEqual([])
    await pending
    expect(requests.map((req) => [req.step_index, req.system, req.tools])).toEqual([
      [0, 'be brief', [tool]],
      [1, 'be brief', [tool]],
    ])
  })

  it('registers no pricing, so a call with a trajectory records pricing_missing', async () => {
    const events: TrajectoryEvent[] = []
    const { engine } = make_loop_engine(['ok'])
    await engine.generate({ prompt: 'x', trajectory: recorder(events) })
    expect(events.filter((event) => event.kind === 'pricing_missing')).toEqual([
      expect.objectContaining({ kind: 'pricing_missing', provider: 'loop', model_id: 'loop' }),
    ])
  })
})
