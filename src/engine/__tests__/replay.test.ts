/**
 * captured_turns and replay_turn: folding a captured trajectory's deltas back
 * into the full request each turn sent, and sending one turn again without
 * running a tool.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { TrajectoryEvent, TrajectoryLogger } from '#core'
import { to_json_schema } from '#schema'
import { create_engine } from '../create_engine.js'
import { captured_turns, replay_turn, type CapturedTurn } from '../replay.js'
import type { CapturePayload, Engine, GenerateOptions, Message, Tool, TurnRequest, TurnResult } from '../types.js'
// The engine zone may not import testing, since testing imports the engine;
// a test may, since nothing in the engine imports a test.
// fallow-ignore-next-line boundary-violation
import { make_loop_engine } from '#testing'

const sum: Tool = {
  name: 'sum',
  description: 'add the numbers up',
  input_schema: z.object({ n: z.number() }),
  execute: () => 3,
}
const add_one = [{ name: 'sum', input: { n: 1 } }] as const

/** A logger that keeps every event, and names each span by its count. */
function recorder(): { trajectory: TrajectoryLogger; events: TrajectoryEvent[] } {
  const events: TrajectoryEvent[] = []
  let spans = 0
  return {
    events,
    trajectory: {
      record: (e) => {
        events.push(e)
      },
      start_span: (name) => {
        spans += 1
        return `${name}-${String(spans)}`
      },
      end_span: () => {},
    },
  }
}

/** What a request's messages look like once JSON has carried them. */
function as_json(messages: ReadonlyArray<Message>): unknown {
  return JSON.parse(JSON.stringify(messages))
}

/** The full array a turn sent: the system prompt the transport hoisted, then its messages. */
function sent_array(req: TurnRequest | undefined): unknown {
  if (req === undefined) return undefined
  const system: Message[] = req.system === undefined ? [] : [{ role: 'system', content: req.system }]
  return as_json([...system, ...req.messages])
}

/** Copy events with one request_sent changed by `change`, found by its call and step. */
function with_request(
  events: ReadonlyArray<TrajectoryEvent>,
  call_span_id: string,
  step_index: number,
  change: (event: Record<string, unknown>) => Record<string, unknown>,
): TrajectoryEvent[] {
  return events.map((e) =>
    e.kind === 'request_sent' && e['call_span_id'] === call_span_id && e['step_index'] === step_index
      ? { ...change({ ...e }), kind: 'request_sent' }
      : e,
  )
}

/** An engine whose one provider, 'scripted', plays `turns` and keeps each request. */
function scripted_engine(
  turns: ReadonlyArray<TurnResult>,
  config: { system?: string; redact_capture?: (payload: CapturePayload) => unknown } = {},
): { engine: Engine; requests: TurnRequest[] } {
  const requests: TurnRequest[] = []
  const engine = create_engine({
    providers: { scripted: {} },
    custom_providers: {
      scripted: () => ({
        kind: 'native',
        name: 'scripted',
        supports: () => true,
        invoke_turn: async (req) => {
          requests.push(req)
          const turn = turns[requests.length - 1]
          if (turn === undefined) throw new Error('script exhausted')
          return turn
        },
      }),
    },
    defaults: {
      provider: 'scripted',
      model: 'scripted',
      ...(config.system === undefined ? {} : { system: config.system }),
    },
    ...(config.redact_capture === undefined ? {} : { redact_capture: config.redact_capture }),
  })
  return { engine, requests }
}

const usage = { input_tokens: 1, output_tokens: 1 }
const call_turn: TurnResult = {
  text: '',
  tool_calls: [{ id: 'c1', name: 'sum', input: { n: 1 } }],
  finish_reason: 'tool_calls',
  usage,
}
const text_turn: TurnResult = { text: 'three', tool_calls: [], finish_reason: 'stop', usage }

describe('captured_turns', () => {
  it('rebuilds every turn of two calls that ran side by side, each from its own deltas', async () => {
    const left = make_loop_engine([add_one, add_one, 'three'])
    const right = make_loop_engine([add_one, 'four'])
    const { trajectory, events } = recorder()
    await Promise.all([
      left.engine.generate({ prompt: 'left', system: 'be brief', tools: [sum], capture: 'turns', trajectory }),
      right.engine.generate({ prompt: 'right', tools: [sum], capture: 'turns', trajectory }),
    ])
    const turns = captured_turns(events)
    const calls = [...new Set(turns.map((t) => t.call_span_id))]
    expect(calls).toHaveLength(2)
    const left_turns = turns.filter((t) => t.messages.some((m) => m.content === 'left'))
    const right_turns = turns.filter((t) => t.messages.some((m) => m.content === 'right'))
    expect(left_turns.map((t) => t.step_index)).toStrictEqual([0, 1, 2])
    expect(right_turns.map((t) => t.step_index)).toStrictEqual([0, 1])
    expect(left_turns.map((t) => t.messages)).toStrictEqual(left.requests.map(sent_array))
    expect(right_turns.map((t) => t.messages)).toStrictEqual(right.requests.map(sent_array))
    expect(left_turns[0]?.settings).toStrictEqual({ provider: 'loop', model_id: 'loop', effort: 'none' })
    expect(left_turns[0]?.tools).toStrictEqual([
      { name: 'sum', description: 'add the numbers up', input_schema: to_json_schema(sum.input_schema) },
    ])
    expect(left_turns.map((t) => t.response)).toStrictEqual([
      [{ type: 'tool_call', id: 'call_0_0', name: 'sum', input: { n: 1 } }],
      [{ type: 'tool_call', id: 'call_1_0', name: 'sum', input: { n: 1 } }],
      [{ type: 'text', text: 'three' }],
    ])
  })

  it('rebuilds the same turns from events in any order', async () => {
    const { engine } = make_loop_engine([add_one, add_one, 'three'])
    const { trajectory, events } = recorder()
    await engine.generate({ prompt: 'add', tools: [sum], capture: 'turns', trajectory })
    const in_order = captured_turns(events)
    const shuffled = events.toReversed()
    shuffled.push(...shuffled.splice(0, 3))
    expect(captured_turns(shuffled)).toStrictEqual(in_order)
    expect(in_order.map((t) => t.step_index)).toStrictEqual([0, 1, 2])
  })

  it('rebuilds a reshaped turn from its whole array, and the turns after it from there', async () => {
    const { engine, requests } = make_loop_engine([add_one, add_one, add_one, 'three'])
    const { trajectory, events } = recorder()
    await engine.generate({
      prompt: 'add',
      tools: [sum],
      capture: 'turns',
      trajectory,
      prepare_step: ({ step_index, messages }) => (step_index === 2 ? { messages: messages.slice(-2) } : undefined),
    })
    const turns = captured_turns(events)
    expect(turns.map((t) => t.messages)).toStrictEqual(requests.map(sent_array))
  })

  it('leaves out a call whose first turn is missing, as in a truncated log', async () => {
    const { engine } = make_loop_engine([add_one, 'three'])
    const { trajectory, events } = recorder()
    await engine.generate({ prompt: 'add', tools: [sum], capture: 'turns', trajectory })
    const truncated = events.filter((e) => !(e.kind === 'request_sent' && e['step_index'] === 0))
    expect(captured_turns(truncated)).toStrictEqual([])
  })

  it('leaves out a turn whose request is missing, a string, or null, until a whole array picks the call up', async () => {
    const { engine } = make_loop_engine([add_one, add_one, add_one, 'three'])
    const { trajectory, events } = recorder()
    await engine.generate({ prompt: 'add', tools: [sum], capture: 'turns', trajectory })
    const call = String(events.find((e) => e.kind === 'request_sent')?.['call_span_id'])
    for (const unreadable of [undefined, '[redacted]', null]) {
      const gapped = with_request(events, call, 1, ({ request: _request, ...rest }) =>
        unreadable === undefined ? rest : { ...rest, request: unreadable },
      )
      expect(captured_turns(gapped).map((t) => t.step_index)).toStrictEqual([0])
    }
    const full = captured_turns(events)
    const picked_up = with_request(
      with_request(events, call, 1, ({ request: _request, ...rest }) => rest),
      call,
      3,
      (e) => ({ ...e, request: { messages: full[3]?.messages, reshaped: true } }),
    )
    expect(captured_turns(picked_up).map((t) => t.step_index)).toStrictEqual([0, 3])
    expect(captured_turns(picked_up)[1]).toStrictEqual(full[3])
  })

  it('picks a call up at the whole array that follows a request the redactor dropped', async () => {
    const { engine, requests } = scripted_engine([call_turn, call_turn, text_turn], {
      redact_capture: (payload) => (payload.kind === 'request' && payload.step_index === 1 ? undefined : payload.data),
    })
    const { trajectory, events } = recorder()
    await engine.generate({ prompt: 'add', tools: [sum], capture: 'turns', trajectory })
    const turns = captured_turns(events)
    expect(turns.map((t) => t.step_index)).toStrictEqual([0, 2])
    expect(turns[1]?.messages).toStrictEqual(sent_array(requests[2]))
  })

  describe('reading hand-built events', () => {
    const settings = { provider: 'p', model_id: 'm', effort: 'none' }
    const first = { settings, tools: [], messages: [{ role: 'user', content: 'a' }] }
    const reply = [{ type: 'text', text: 'b' }]
    const turn_0 = { call_span_id: 'g', step_index: 0, settings, tools: [], messages: first.messages }

    /** A request_sent for call `g` at `step_index`. */
    function sent(step_index: unknown, request: unknown, extra: Record<string, unknown> = {}): TrajectoryEvent {
      return { kind: 'request_sent', step_index, span_id: `s${String(step_index)}`, call_span_id: 'g', request, ...extra }
    }

    it('applies a delta only on top of the step just before it', () => {
      expect(captured_turns([sent(0, first), sent(2, { appended: [{ role: 'user', content: 'c' }] })])).toStrictEqual([turn_0])
    })

    it('reads only request_sent events that name their call and a numbered step', () => {
      const { call_span_id: _call, ...no_call } = sent(0, first)
      expect(
        captured_turns([
          sent(0, first),
          { ...no_call, call_span_id: 'h' },
          { ...no_call, call_span_id: 7 },
          sent('1', { appended: [{ role: 'user', content: 'c' }] }),
          { kind: 'emit', call_span_id: 'g', step_index: 1, request: { appended: [] } },
        ]).map((t) => [t.call_span_id, t.step_index]),
      ).toStrictEqual([
        ['g', 0],
        ['h', 0],
      ])
    })

    it.each([
      ['a string', '[redacted]'],
      ['null', null],
      ['no tools', { settings, messages: first.messages }],
      ['no messages', { settings, tools: [] }],
      ['null settings', { ...first, settings: null }],
      ['string settings', { ...first, settings: 'p' }],
      ['a provider that is no string', { ...first, settings: { ...settings, provider: 1 } }],
      ['a model that is no string', { ...first, settings: { ...settings, model_id: 2 } }],
    ])('leaves out a call whose first request has %s, whole arrays after it included', (_label, request) => {
      expect(captured_turns([sent(0, request), sent(1, { messages: first.messages, reshaped: true })])).toStrictEqual([])
    })

    it('leaves out a call with no step 0, even when its first step looks whole', () => {
      expect(captured_turns([sent(1, first)])).toStrictEqual([])
    })

    it("attaches a reply only by its own step span, and only a response_received's list of parts", () => {
      const span_less = { kind: 'request_sent', step_index: 0, call_span_id: 'k', request: first }
      expect(
        captured_turns([
          sent(0, first),
          span_less,
          { kind: 'response_received', step_index: 0, span_id: 's0', content: reply },
          { kind: 'emit', span_id: 's0', content: [{ type: 'text', text: 'not a reply' }] },
          { kind: 'cost', span_id: 's0', step_index: 0 },
          { kind: 'response_received', step_index: 0, content: [{ type: 'text', text: 'no span' }] },
          { kind: 'response_received', step_index: 1, span_id: 's1', content: 'not parts' },
          sent(1, { appended: [] }),
        ]),
      ).toStrictEqual([
        { ...turn_0, response: reply },
        { ...turn_0, step_index: 1 },
        { ...turn_0, call_span_id: 'k' },
      ])
    })
  })
})

describe('replay_turn', () => {
  /** Capture one call on a fresh double and return its turns. */
  async function capture(turns: Parameters<typeof make_loop_engine>[0], opts: { system?: string; provider_options?: Record<string, unknown> } = {}): Promise<CapturedTurn[]> {
    const { engine } = make_loop_engine(turns)
    const { trajectory, events } = recorder()
    await engine.generate({ prompt: 'add', tools: [sum], capture: 'turns', trajectory, ...opts })
    return captured_turns(events)
  }

  it("sends the turn's whole request, with its settings and tools, as one turn", async () => {
    const [turn] = await capture(['three'], { system: 'be brief', provider_options: { loop: { seed: 7 } } })
    if (turn === undefined) throw new Error('no turn captured')
    const replaying = make_loop_engine(['three again'])
    const result = await replay_turn(replaying.engine, turn)
    expect(result.content).toBe('three again')
    const [req] = replaying.requests
    expect(req?.system).toBe('be brief')
    expect(as_json(req?.messages ?? [])).toStrictEqual([{ role: 'user', content: 'add' }])
    expect(req?.provider_options).toStrictEqual({ loop: { seed: 7 } })
    expect(req?.tools.map((t) => [t.name, t.description, to_json_schema(t.input_schema)])).toStrictEqual([
      ['sum', 'add the numbers up', to_json_schema(sum.input_schema)],
    ])
    expect(req?.effort).toBe('none')
  })

  it('never runs a tool: a call comes back listed and unexecuted', async () => {
    const [turn] = await capture(['three'])
    if (turn === undefined) throw new Error('no turn captured')
    const replaying = make_loop_engine([add_one])
    const result = await replay_turn(replaying.engine, turn)
    expect(result.finish_reason).toBe('max_steps')
    expect(result.tool_calls).toMatchObject([
      { id: 'call_0_0', name: 'sum', input: { n: 1 }, error: { message: 'max_steps_exceeded_before_execution' } },
    ])
    expect(replaying.requests).toHaveLength(1)
  })

  it('keeps a tool that could never run from running, even under a call it can make', async () => {
    const [turn] = await capture(['three'])
    if (turn === undefined) throw new Error('no turn captured')
    const tools: Tool[] = []
    const spy: Engine = {
      ...make_loop_engine([]).engine,
      generate: async (opts) => {
        tools.push(...(opts.tools ?? []))
        return await make_loop_engine(['ok']).engine.generate(opts)
      },
    }
    await replay_turn(spy, turn)
    const ctx = { abort: new AbortController().signal, tool_call_id: 'c', step_index: 0 }
    expect(() => tools[0]?.execute({ n: 1 }, ctx)).toThrow(
      "replay_turn never runs a tool: the model called 'sum'",
    )
  })

  it('passes generate only what the turn captured, beside what a replay always sets', async () => {
    const seen: Array<GenerateOptions<unknown>> = []
    const spy: Engine = {
      ...make_loop_engine([]).engine,
      generate: async (opts) => {
        seen.push(opts)
        return await make_loop_engine(['ok']).engine.generate(opts)
      },
    }
    const [bare] = await capture(['three'])
    if (bare === undefined) throw new Error('no turn captured')
    await replay_turn(spy, bare)
    expect(Object.keys(seen[0] ?? {}).toSorted()).toStrictEqual(
      ['cache', 'capture', 'effort', 'max_steps', 'model', 'prompt', 'provider', 'system', 'tools'],
    )
    expect(seen[0]).toMatchObject({ cache: 'off', capture: 'off', max_steps: 1, system: '', provider: 'loop', model: 'loop' })
    const { trajectory } = recorder()
    await replay_turn(spy, {
      ...bare,
      settings: { ...bare.settings, temperature: 0.1, max_tokens: 9, top_p: 0.5, provider_options: { loop: { a: 1 } } },
    }, { trajectory })
    expect(Object.keys(seen[1] ?? {}).toSorted()).toStrictEqual([
      'cache', 'capture', 'effort', 'max_steps', 'max_tokens', 'model', 'prompt', 'provider', 'provider_options',
      'system', 'temperature', 'tools', 'top_p', 'trajectory',
    ])
  })

  it('sends a turn that edit changed, to the provider and model it names', async () => {
    const [turn] = await capture(['three'])
    if (turn === undefined) throw new Error('no turn captured')
    const base = make_loop_engine([])
    const other: TurnRequest[] = []
    const engine = base.engine.with_providers(
      { other: {} },
      {
        other: () => ({
          kind: 'native',
          name: 'other',
          supports: () => true,
          invoke_turn: async (req) => {
            other.push(req)
            return text_turn
          },
        }),
      },
    )
    await replay_turn(engine, turn, {
      provider: 'other',
      model: 'other-model',
      edit: (t) => ({ ...t, messages: [...t.messages, { role: 'user', content: 'and again' }] }),
    })
    expect(base.requests).toStrictEqual([])
    expect(other[0]?.model_id).toBe('other-model')
    expect(as_json(other[0]?.messages ?? [])).toStrictEqual([
      { role: 'user', content: 'add' },
      { role: 'user', content: 'and again' },
    ])
  })

  it("sends a raw cache_control as it was captured, and derives no cache of its own", async () => {
    const raw = { anthropic: { cache_control: { type: 'ephemeral', ttl: '1h' } } }
    const [turn] = await capture(['three'], { provider_options: raw })
    if (turn === undefined) throw new Error('no turn captured')
    const replaying = make_loop_engine(['ok'], { prompt_cache: 'with_tools' })
    await replay_turn(replaying.engine, turn)
    expect(replaying.requests[0]?.provider_options).toStrictEqual(raw)
    expect('cache' in (replaying.requests[0] ?? {})).toBe(false)
  })

  it("sends one system prompt on an engine with defaults.system, the captured one", async () => {
    const [turn] = await capture(['three'], { system: 'captured system' })
    if (turn === undefined) throw new Error('no turn captured')
    const replaying = scripted_engine([text_turn], { system: 'engine default' })
    await replay_turn(replaying.engine, turn, { provider: 'scripted' })
    expect(replaying.requests[0]?.system).toBe('captured system')
    const [no_system] = await capture(['three'])
    if (no_system === undefined) throw new Error('no turn captured')
    const bare = scripted_engine([text_turn], { system: 'engine default' })
    await replay_turn(bare.engine, no_system, { provider: 'scripted' })
    expect(bare.requests[0]?.system).toBeUndefined()
  })

  it('sends the sampling settings it captured, and leaves the schema out', async () => {
    const { engine } = make_loop_engine(['{"n":3}'])
    const { trajectory, events } = recorder()
    await engine.generate({
      prompt: 'add',
      schema: z.object({ n: z.number() }),
      temperature: 0.2,
      max_tokens: 64,
      top_p: 0.9,
      effort: 'high',
      capture: 'turns',
      trajectory,
    })
    const [turn] = captured_turns(events)
    if (turn === undefined) throw new Error('no turn captured')
    expect(turn.settings.schema).toStrictEqual(to_json_schema(z.object({ n: z.number() })))
    const replaying = make_loop_engine(['not json at all'])
    const result = await replay_turn(replaying.engine, turn, { trajectory: recorder().trajectory })
    expect(result.content).toBe('not json at all')
    expect(replaying.requests[0]).toMatchObject({ temperature: 0.2, max_tokens: 64, top_p: 0.9, effort: 'high' })
    expect('schema' in (replaying.requests[0] ?? {})).toBe(false)
  })

  it('rebuilds a tool whose schema went uncaptured to take any object', async () => {
    const [turn] = await capture(['three'])
    if (turn === undefined) throw new Error('no turn captured')
    const replaying = make_loop_engine(['ok'])
    await replay_turn(replaying.engine, { ...turn, tools: [{ name: 'free', description: 'takes anything' }] })
    const [tool] = replaying.requests[0]?.tools ?? []
    expect(tool === undefined ? undefined : to_json_schema(tool.input_schema)).toStrictEqual({ type: 'object' })
  })

  it('records a replay on the trajectory it is given, capturing nothing', async () => {
    const [turn] = await capture(['three'])
    if (turn === undefined) throw new Error('no turn captured')
    const { trajectory, events } = recorder()
    await replay_turn(make_loop_engine(['ok']).engine, turn, { trajectory })
    const sent = events.filter((e) => e.kind === 'request_sent')
    expect(sent).toHaveLength(1)
    expect('request' in (sent[0] ?? {})).toBe(false)
  })
})
