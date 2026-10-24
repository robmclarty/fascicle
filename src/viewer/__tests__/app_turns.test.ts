import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SpanInfo } from '../app/lib/reduce.js'
import { EMPTY_SESSION, apply_frame } from '../app/lib/scene.js'
import {
  DRAWER_MAX_WIDTH,
  DRAWER_SHARE,
  FOLD_CHARS,
  FOLD_LINES,
  KEEP_CHARS,
  KEEP_LINES,
  captured_turn_json,
  copy_label,
  drawer_meta,
  drawer_view,
  drawer_width,
  fold_text,
  read_turns,
  request_view,
  response_view,
  selected_index,
  turn_row,
  turns_badge,
  turns_by_node,
  turns_label,
  type ViewerTurn,
} from '../app/lib/turns.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const SETTINGS = { provider: 'anthropic', model_id: 'claude-sonnet-5-5', effort: 'none' }
const TOOLS = [{ name: 'get_weather', description: 'The forecast.', input_schema: { type: 'object' } }]
const SYSTEM = { role: 'system', content: 'You plan trips.' }
const ASK = { role: 'user', content: 'Plan a weekend.' }
const CALL = { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'get_weather', input: { city: 'Lisbon' } }] }
const RESULT = { role: 'tool', tool_call_id: 'c1', name: 'get_weather', content: '{"high_c":19}' }
const ANSWER = { role: 'assistant', content: 'Go to Alfama.' }
const THANKS = { role: 'user', content: 'Thanks.' }

/** A `request_sent` for one turn of a call, its step span named after both. */
function sent(call: string, step_index: number, request: unknown): Record<string, unknown> {
  return { kind: 'request_sent', step_index, span_id: `${call}.step:${step_index}`, call_span_id: call, request }
}

/** A `response_received` for one turn of a call. */
function received(call: string, step_index: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'response_received', step_index, span_id: `${call}.step:${step_index}`, ...fields }
}

const FIRST = { settings: SETTINGS, tools: TOOLS, messages: [SYSTEM, ASK] }

/** A three-turn call: a whole first request, then two that append. */
function three_turns(call: string): ReadonlyArray<Record<string, unknown>> {
  return [
    sent(call, 0, FIRST),
    sent(call, 1, { appended: [CALL, RESULT] }),
    sent(call, 2, { appended: [ANSWER, THANKS] }),
  ]
}

/** A turn built field by field, the fields a test doesn't name set plainly. */
function turn(fields: Partial<ViewerTurn> = {}): ViewerTurn {
  return {
    call_span_id: 'engine:a',
    step_index: 0,
    settings: SETTINGS,
    tools: TOOLS,
    messages: [SYSTEM, ASK],
    usage: null,
    ...fields,
  }
}

/** A span registry entry: joined to a node, or an engine span that isn't. */
function span(node_id: string | null, parent_span_id: string | null): SpanInfo {
  return {
    name: node_id === null ? 'engine.generate' : 'step',
    step_id: node_id,
    node_id,
    parent_span_id,
    open: false,
    failed_descendant: false,
    failed_joined_descendant: false,
  }
}

describe('read_turns', () => {
  it('reads a first turn whole: its settings, its tools, and every message', () => {
    expect(read_turns([sent('engine:a', 0, FIRST)])).toStrictEqual([
      { call_span_id: 'engine:a', step_index: 0, settings: SETTINGS, tools: TOOLS, messages: [SYSTEM, ASK], usage: null },
    ])
  })

  it('rebuilds each appended turn on top of the turn before it', () => {
    const turns = read_turns(three_turns('engine:a'))
    expect(turns.map((t) => t.messages)).toStrictEqual([
      [SYSTEM, ASK],
      [SYSTEM, ASK, CALL, RESULT],
      [SYSTEM, ASK, CALL, RESULT, ANSWER, THANKS],
    ])
    expect(turns.map((t) => t.step_index)).toStrictEqual([0, 1, 2])
    // Every turn carries the call's settings and tools, which only the first sent.
    for (const t of turns) {
      expect(t.settings).toBe(SETTINGS)
      expect(t.tools).toBe(TOOLS)
    }
  })

  it('takes a reshaped turn as its own whole array, and appends on top of it after', () => {
    const turns = read_turns([
      sent('engine:a', 0, FIRST),
      sent('engine:a', 1, { messages: [SYSTEM, THANKS], reshaped: true }),
      sent('engine:a', 2, { appended: [ANSWER] }),
    ])
    expect(turns.map((t) => t.messages)).toStrictEqual([[SYSTEM, ASK], [SYSTEM, THANKS], [SYSTEM, THANKS, ANSWER]])
  })

  it('leaves out a turn whose request was dropped, and the deltas after it, until a whole array', () => {
    for (const dropped of [undefined, null, '[redacted]', { appended: 'not a list' }, { other: [] }]) {
      const turns = read_turns([
        sent('engine:a', 0, FIRST),
        sent('engine:a', 1, dropped),
        sent('engine:a', 2, { appended: [ANSWER] }),
        sent('engine:a', 3, { messages: [SYSTEM, ASK, CALL], reshaped: true }),
        sent('engine:a', 4, { appended: [RESULT] }),
      ])
      expect(turns.map((t) => t.step_index)).toStrictEqual([0, 3, 4])
      expect(turns[2]?.messages).toStrictEqual([SYSTEM, ASK, CALL, RESULT])
    }
  })

  it('applies a delta only on the step just before it, never across a gap in the steps', () => {
    const turns = read_turns([sent('engine:a', 0, FIRST), sent('engine:a', 2, { appended: [ANSWER] })])
    expect(turns.map((t) => t.step_index)).toStrictEqual([0])
  })

  it('leaves out a truncated call whose first turn is missing', () => {
    expect(read_turns(three_turns('engine:a').slice(1))).toStrictEqual([])
  })

  it('reads only step 0 as a first turn, whatever a later step holds', () => {
    expect(read_turns([sent('engine:a', 1, FIRST), sent('engine:a', 2, { appended: [ANSWER] })])).toStrictEqual([])
  })

  it('drops a request whose step is unreadable from a call it would otherwise join', () => {
    const turns = read_turns([
      sent('engine:a', 0, FIRST),
      { ...sent('engine:a', 1, { messages: [SYSTEM, THANKS], reshaped: true }), step_index: 'one' },
    ])
    expect(turns.map((t) => t.step_index)).toStrictEqual([0])
  })

  it('leaves out a call whose first request is not a whole one', () => {
    const unreadable = [
      { tools: TOOLS, messages: [ASK] },
      { settings: SETTINGS, messages: [ASK] },
      { settings: SETTINGS, tools: TOOLS },
      { settings: SETTINGS, tools: TOOLS, messages: 'hi' },
      { settings: 'anthropic', tools: TOOLS, messages: [ASK] },
      { settings: { model_id: 'm' }, tools: TOOLS, messages: [ASK] },
      { settings: { provider: 'p' }, tools: TOOLS, messages: [ASK] },
      { settings: { provider: 1, model_id: 'm' }, tools: TOOLS, messages: [ASK] },
      { settings: { provider: 'p', model_id: 2 }, tools: TOOLS, messages: [ASK] },
      [SYSTEM, ASK],
      null,
    ]
    for (const request of unreadable) {
      expect(read_turns([sent('engine:a', 0, request), sent('engine:a', 1, { appended: [ANSWER] })])).toStrictEqual([])
    }
  })

  it('keeps parallel calls apart by call, each in the order it first appeared', () => {
    const a = three_turns('engine:a')
    const b = [
      sent('engine:b', 0, { settings: { provider: 'openai', model_id: 'gpt' }, tools: [], messages: [THANKS] }),
      sent('engine:b', 1, { appended: [ANSWER] }),
    ]
    const turns = read_turns([b[0], a[0], a[1], b[1], a[2]])
    expect(turns.map((t) => `${t.call_span_id}:${t.step_index}`)).toStrictEqual([
      'engine:b:0',
      'engine:b:1',
      'engine:a:0',
      'engine:a:1',
      'engine:a:2',
    ])
    expect(turns[1]?.messages).toStrictEqual([THANKS, ANSWER])
    expect(turns[1]?.settings).toStrictEqual({ provider: 'openai', model_id: 'gpt' })
  })

  it('folds a call whose events arrived out of order by its steps', () => {
    const [zero, one, two] = three_turns('engine:a')
    const turns = read_turns([two, zero, one])
    expect(turns.map((t) => t.step_index)).toStrictEqual([0, 1, 2])
    expect(turns[2]?.messages).toHaveLength(6)
  })

  it('joins each turn to the reply and usage its step span recorded', () => {
    const turns = read_turns([
      ...three_turns('engine:a'),
      received('engine:a', 1, {
        input_tokens: 2786,
        output_tokens: 71,
        cached_input_tokens: 2204,
        cache_write_tokens: 371,
        cache_hit_ratio: 0.791,
        content: [{ type: 'text', text: 'Saturday is bright.' }],
      }),
      received('engine:a', 2, { input_tokens: 10, content: 'not a list' }),
    ])
    expect(turns[0]).not.toHaveProperty('response')
    expect(turns[0]?.usage).toBeNull()
    expect(turns[1]?.response).toStrictEqual([{ type: 'text', text: 'Saturday is bright.' }])
    expect(turns[1]?.usage).toStrictEqual({
      input_tokens: 2786,
      output_tokens: 71,
      cached_input_tokens: 2204,
      cache_write_tokens: 371,
      cache_hit_ratio: 0.791,
    })
    // A reply whose content isn't a list still reports its usage.
    expect(turns[2]).not.toHaveProperty('response')
    expect(turns[2]?.usage).toStrictEqual({
      input_tokens: 10,
      output_tokens: null,
      cached_input_tokens: null,
      cache_write_tokens: null,
      cache_hit_ratio: null,
    })
  })

  it('reads a count that is not a finite number as unreported', () => {
    const [turn_0] = read_turns([
      sent('engine:a', 0, FIRST),
      received('engine:a', 0, { input_tokens: '12', output_tokens: Number.NaN, cache_hit_ratio: Infinity }),
    ])
    expect(turn_0?.usage?.input_tokens).toBeNull()
    expect(turn_0?.usage?.output_tokens).toBeNull()
    expect(turn_0?.usage?.cache_hit_ratio).toBeNull()
  })

  it('joins no reply to a turn whose request named no step span', () => {
    const event = { kind: 'request_sent', step_index: 0, call_span_id: 'engine:a', request: FIRST }
    const [only] = read_turns([event, { kind: 'response_received', input_tokens: 5 }])
    expect(only?.usage).toBeNull()
  })

  it('ignores what is not a request it can place: other kinds, no call, no step, and no event at all', () => {
    const turns = read_turns([
      null,
      'request_sent',
      [sent('engine:a', 0, FIRST)],
      { ...sent('engine:x', 0, FIRST), kind: 'request_wire' },
      { ...sent('engine:x', 0, FIRST), call_span_id: 7 },
      { ...sent('engine:x', 0, FIRST), step_index: '0' },
      { ...sent('engine:x', 0, FIRST), step_index: Number.NaN },
      { kind: 'request_sent', step_index: 0, span_id: 's', request: FIRST },
    ])
    expect(turns).toStrictEqual([])
  })

  it('takes a response_received as a reply only, never as a request', () => {
    const turns = read_turns([{ ...received('engine:a', 0), call_span_id: 'engine:a', request: FIRST }])
    expect(turns).toStrictEqual([])
  })
})

describe('turns_by_node', () => {
  const spans = new Map<string, SpanInfo>([
    ['step:plan', span('plan_trip', 'seq:1')],
    ['seq:1', span('sequence_1', null)],
    ['engine:a', span(null, 'step:plan')],
    ['engine:b', span(null, 'engine:mid')],
    ['engine:mid', span(null, 'step:book')],
    ['step:book', span('book_hotel', null)],
    ['engine:orphan', span(null, null)],
    ['engine:lost', span(null, 'engine:gone')],
  ])

  it('hangs each call on the nearest node up its span chain, keeping the turns in order', () => {
    const turns = [
      turn({ call_span_id: 'engine:a', step_index: 0 }),
      turn({ call_span_id: 'engine:b', step_index: 0 }),
      turn({ call_span_id: 'engine:a', step_index: 1 }),
    ]
    const by_node = turns_by_node(turns, spans)
    expect([...by_node.keys()]).toStrictEqual(['plan_trip', 'book_hotel'])
    expect(by_node.get('plan_trip')).toStrictEqual([turns[0], turns[2]])
    expect(by_node.get('book_hotel')).toStrictEqual([turns[1]])
  })

  it('leaves out a call whose chain joins no node, or that the fold never saw', () => {
    const turns = ['engine:orphan', 'engine:lost', 'engine:unknown'].map((call) => turn({ call_span_id: call }))
    expect(turns_by_node(turns, spans).size).toBe(0)
  })

  it('stops on a span chain that loops back on itself', () => {
    const loop = new Map<string, SpanInfo>([
      ['engine:a', span(null, 'engine:b')],
      ['engine:b', span(null, 'engine:a')],
    ])
    expect(turns_by_node([turn()], loop).size).toBe(0)
  })

  it('reaches a node at the end of a chain as long as the registry', () => {
    const chain = new Map<string, SpanInfo>([
      ['engine:a', span(null, 'mid')],
      ['mid', span(null, 'step')],
      ['step', span('node', null)],
    ])
    expect([...turns_by_node([turn()], chain).keys()]).toStrictEqual(['node'])
  })
})

describe('the captured fixture', () => {
  const events = readFileSync(join(HERE, 'fixtures', 'turns.trajectory.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line))

  it('rebuilds every turn of the run, the parallel calls kept apart', () => {
    const turns = read_turns(events)
    expect(turns.map((t) => [t.step_index, t.messages.length])).toStrictEqual([
      [0, 2],
      [1, 5],
      [2, 7],
      [0, 1],
      [0, 1],
      [1, 3],
    ])
  })

  it('hangs each call on the model-call node whose step made it', () => {
    let session = EMPTY_SESSION
    for (const event of events) session = apply_frame(session, event)
    const by_node = turns_by_node(read_turns(events), session.state.spans)
    expect([...by_node].map(([node, list]) => [node, list.length])).toStrictEqual([
      ['plan_trip', 3],
      ['packing_list', 1],
      ['book_hotel', 2],
    ])
  })
})

describe('captured_turn_json', () => {
  it('writes the CapturedTurn shape, the drawer usage left behind', () => {
    const shown = turn({
      step_index: 2,
      response: [{ type: 'text', text: 'Go.' }],
      usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: null, cache_write_tokens: null, cache_hit_ratio: null },
    })
    const json = captured_turn_json(shown)
    expect(JSON.parse(json)).toStrictEqual({
      call_span_id: 'engine:a',
      step_index: 2,
      settings: SETTINGS,
      tools: TOOLS,
      messages: [SYSTEM, ASK],
      response: [{ type: 'text', text: 'Go.' }],
    })
    expect(json).toContain('\n  "call_span_id": "engine:a",\n')
  })

  it('leaves out the response when the log held none', () => {
    expect(JSON.parse(captured_turn_json(turn()))).not.toHaveProperty('response')
  })
})

describe('turns_label', () => {
  it('counts one turn singular and the rest plural', () => {
    expect(turns_label(1)).toBe('1 TURN')
    expect(turns_label(2)).toBe('2 TURNS')
    expect(turns_label(12)).toBe('12 TURNS')
  })
})

describe('turn_row', () => {
  const usage = { input_tokens: 2412, output_tokens: 96, cached_input_tokens: 0, cache_write_tokens: 2204, cache_hit_ratio: 0 }

  it('reads the step, both sides of the tokens grouped, and the cache hit as a whole percent', () => {
    expect(turn_row(turn({ step_index: 0, usage }))).toStrictEqual({
      step: 'STEP 0',
      tokens: '2,412 IN · 96 OUT',
      cache: 'CACHE 0%',
    })
    expect(turn_row(turn({ step_index: 1, usage: { ...usage, cache_hit_ratio: 0.791 } })).cache).toBe('CACHE 79%')
    expect(turn_row(turn({ usage: { ...usage, cache_hit_ratio: 0.885 } })).cache).toBe('CACHE 89%')
  })

  it('shows no cache hit on a turn without cache traffic', () => {
    expect(turn_row(turn({ usage: { ...usage, cache_hit_ratio: null } })).cache).toBeNull()
  })

  it('drops a side the reply did not report, and says when no reply was recorded', () => {
    expect(turn_row(turn({ usage: { ...usage, output_tokens: null } })).tokens).toBe('2,412 IN')
    expect(turn_row(turn({ usage: { ...usage, input_tokens: null } })).tokens).toBe('96 OUT')
    expect(turn_row(turn({ usage: { ...usage, input_tokens: null, output_tokens: null } })).tokens).toBe('NO USAGE')
    expect(turn_row(turn())).toStrictEqual({ step: 'STEP 0', tokens: 'NO USAGE', cache: null })
  })
})

describe('drawer_meta', () => {
  it('counts the turns and names the provider and the model verbatim', () => {
    expect(drawer_meta([turn(), turn()])).toStrictEqual({
      count: '2 TURNS',
      model: 'anthropic · claude-sonnet-5-5',
    })
  })

  it('names what the settings hold, and nothing when they hold neither', () => {
    expect(drawer_meta([turn({ settings: { provider: 'openai' } })]).model).toBe('openai')
    expect(drawer_meta([turn({ settings: { model_id: 'gpt' } })]).model).toBe('gpt')
    expect(drawer_meta([turn({ settings: { provider: 3 } })])).toStrictEqual({ count: '1 TURN', model: null })
    expect(drawer_meta([])).toStrictEqual({ count: '0 TURNS', model: null })
  })
})

describe('selected_index', () => {
  it('shows the newest turn until one is picked', () => {
    expect(selected_index(null, 3)).toBe(2)
    expect(selected_index(null, 0)).toBe(0)
  })

  it('holds a pick inside the list as it changes', () => {
    expect(selected_index(1, 3)).toBe(1)
    expect(selected_index(0, 3)).toBe(0)
    expect(selected_index(2, 3)).toBe(2)
    expect(selected_index(5, 3)).toBe(2)
    expect(selected_index(-1, 3)).toBe(0)
    expect(selected_index(4, 0)).toBe(0)
  })
})

describe('copy_label', () => {
  it('offers the copy until the shown turn has been copied', () => {
    expect(copy_label(null, 0)).toBe('COPY TURN')
    expect(copy_label({ index: 0, ok: true }, 0)).toBe('COPIED')
    expect(copy_label({ index: 0, ok: false }, 0)).toBe('COPY FAILED')
    expect(copy_label({ index: 1, ok: true }, 0)).toBe('COPY TURN')
  })
})

describe('request_view', () => {
  it('lays out the leading system prompt, the tool names, and the messages by role', () => {
    const view = request_view(
      turn({
        tools: [TOOLS[0], { name: 'convert_currency' }, { description: 'nameless' }, 'not a tool'],
        messages: [SYSTEM, ASK, CALL, RESULT, ANSWER],
      }),
    )
    expect(view.system).toStrictEqual(['You plan trips.'])
    expect(view.tools).toBe('get_weather · convert_currency')
    expect(view.messages).toStrictEqual([
      { role: 'user', label: 'USER', name: null, error: false, blocks: [{ label: null, name: null, format: 'text', body: 'Plan a weekend.' }] },
      {
        role: 'assistant',
        label: 'ASSISTANT',
        name: null,
        error: false,
        blocks: [{ label: 'CALL', name: 'get_weather', format: 'code', body: '{\n  "city": "Lisbon"\n}' }],
      },
      {
        role: 'tool',
        label: 'TOOL',
        name: 'get_weather',
        error: false,
        blocks: [{ label: null, name: null, format: 'code', body: '{\n  "high_c": 19\n}' }],
      },
      { role: 'assistant', label: 'ASSISTANT', name: null, error: false, blocks: [{ label: null, name: null, format: 'text', body: 'Go to Alfama.' }] },
    ])
  })

  it('reads every leading system message as the prompt, and keeps a later one in the list', () => {
    const late = { role: 'system', content: 'Be brief.' }
    const view = request_view(turn({ messages: [SYSTEM, { role: 'system', content: 'Use metric.' }, ASK, late] }))
    expect(view.system).toStrictEqual(['You plan trips.', 'Use metric.'])
    expect(view.messages.map((m) => m.label)).toStrictEqual(['USER', 'SYSTEM'])
  })

  it('has no system prompt and no tools when the turn sent neither', () => {
    const view = request_view(turn({ tools: [], messages: [ASK] }))
    expect(view.system).toStrictEqual([])
    expect(view.tools).toBe('')
    expect(view.messages).toHaveLength(1)
  })

  it('reads a turn of system messages alone as all prompt', () => {
    expect(request_view(turn({ messages: [SYSTEM] }))).toStrictEqual({ system: ['You plan trips.'], tools: 'get_weather', messages: [] })
  })

  it('treats a system message whose content is not text as a message, not the prompt', () => {
    const odd = { role: 'system', content: [{ type: 'text', text: 'x' }] }
    const view = request_view(turn({ messages: [odd, ASK] }))
    expect(view.system).toStrictEqual([])
    expect(view.messages.map((m) => m.label)).toStrictEqual(['SYSTEM', 'USER'])
  })

  it('marks a tool result flagged is_error, and only a true flag', () => {
    const failed = { ...RESULT, content: '{"error":"timed out"}', is_error: true }
    const view = request_view(turn({ messages: [failed, { ...RESULT, is_error: 'yes' }] }))
    expect(view.messages.map((m) => m.error)).toStrictEqual([true, false])
    expect(view.messages[0]?.blocks).toStrictEqual([{ label: null, name: null, format: 'code', body: '{\n  "error": "timed out"\n}' }])
  })

  it('reads a tool result that is not JSON as text, and JSON that is not an object as text too', () => {
    const view = request_view(
      turn({ messages: [{ ...RESULT, content: 'sunny' }, { ...RESULT, content: '42' }, { ...RESULT, content: 'null' }] }),
    )
    expect(view.messages.map((m) => m.blocks[0])).toStrictEqual([
      { label: null, name: null, format: 'text', body: 'sunny' },
      { label: null, name: null, format: 'text', body: '42' },
      { label: null, name: null, format: 'text', body: 'null' },
    ])
  })

  it('reads a JSON array result as code', () => {
    const view = request_view(turn({ messages: [{ ...RESULT, content: '[1]' }] }))
    expect(view.messages[0]?.blocks[0]).toStrictEqual({ label: null, name: null, format: 'code', body: '[\n  1\n]' })
  })

  it('keeps a tool result whose content is parts, and one that names no tool', () => {
    const view = request_view(turn({ messages: [{ role: 'tool', content: [{ type: 'text', text: 'ok' }] }] }))
    expect(view.messages[0]).toStrictEqual({
      role: 'tool',
      label: 'TOOL',
      name: null,
      error: false,
      blocks: [{ label: null, name: null, format: 'text', body: 'ok' }],
    })
  })

  it('shows a message it cannot read as JSON', () => {
    const view = request_view(turn({ messages: ['loose', { content: 'no role' }, { role: 'user', content: 7 }] }))
    expect(view.messages).toStrictEqual([
      { role: 'unknown', label: 'MESSAGE', name: null, error: false, blocks: [{ label: null, name: null, format: 'code', body: '"loose"' }] },
      { role: 'unknown', label: 'UNKNOWN', name: null, error: false, blocks: [{ label: null, name: null, format: 'text', body: 'no role' }] },
      { role: 'user', label: 'USER', name: null, error: false, blocks: [{ label: null, name: null, format: 'code', body: '7' }] },
    ])
  })
})

describe('response_view', () => {
  it('lays out each part the provider sent, in order', () => {
    const blocks = response_view(
      turn({
        response: [
          { type: 'reasoning', text: 'Check the weather first.' },
          { type: 'reasoning', text: '' },
          { type: 'reasoning' },
          { type: 'text', text: 'Checking.' },
          { type: 'text' },
          { type: 'tool_call', id: 'c1', name: 'get_weather', input: { city: 'Lisbon' } },
          { type: 'tool_call', id: 'c2', input: {} },
          { type: 'opaque', provider_options: { anthropic: { block: { type: 'server_tool_use', id: 's1' } } } },
          { type: 'opaque', provider_options: { anthropic: 'flat', other: { block: { id: 'x' } } } },
          { type: 'opaque', provider_options: { first: {}, anthropic: { block: { type: 'web_search_tool_result' } } } },
          { type: 'opaque', provider_options: 'odd' },
          { type: 'opaque', provider_options: [{ block: { type: 'listed' } }] },
          { type: 'opaque' },
          { type: 'mystery', value: 1 },
          'loose',
          null,
        ],
      }),
    )
    expect(blocks).toStrictEqual([
      { label: 'REASONING', name: null, format: 'text', body: 'Check the weather first.' },
      { label: 'REASONING', name: null, format: 'text', body: '(hidden by the provider)' },
      { label: 'REASONING', name: null, format: 'text', body: '(hidden by the provider)' },
      { label: null, name: null, format: 'text', body: 'Checking.' },
      { label: null, name: null, format: 'text', body: '' },
      { label: 'CALL', name: 'get_weather', format: 'code', body: '{\n  "city": "Lisbon"\n}' },
      { label: 'CALL', name: null, format: 'code', body: '{}' },
      {
        label: 'OPAQUE',
        name: 'server_tool_use',
        format: 'code',
        body: '{\n  "anthropic": {\n    "block": {\n      "type": "server_tool_use",\n      "id": "s1"\n    }\n  }\n}',
      },
      {
        label: 'OPAQUE',
        name: null,
        format: 'code',
        body: '{\n  "anthropic": "flat",\n  "other": {\n    "block": {\n      "id": "x"\n    }\n  }\n}',
      },
      {
        label: 'OPAQUE',
        name: 'web_search_tool_result',
        format: 'code',
        body: '{\n  "first": {},\n  "anthropic": {\n    "block": {\n      "type": "web_search_tool_result"\n    }\n  }\n}',
      },
      { label: 'OPAQUE', name: null, format: 'code', body: '"odd"' },
      {
        label: 'OPAQUE',
        name: null,
        format: 'code',
        body: '[\n  {\n    "block": {\n      "type": "listed"\n    }\n  }\n]',
      },
      { label: 'OPAQUE', name: null, format: 'code', body: 'undefined' },
      { label: null, name: null, format: 'code', body: '{\n  "type": "mystery",\n  "value": 1\n}' },
      { label: null, name: null, format: 'code', body: '"loose"' },
      { label: null, name: null, format: 'code', body: 'null' },
    ])
  })

  it('reads an image as its type and the size of its bytes', () => {
    const blocks = request_view(
      turn({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', image: 'AAAAAAAA', media_type: 'image/png' },
              { type: 'image', image: 'A'.repeat(4000) },
              { type: 'image', image: { 0: 1 }, media_type: 'image/jpeg' },
            ],
          },
        ],
      }),
    ).messages[0]?.blocks
    expect(blocks).toStrictEqual([
      { label: 'IMAGE', name: null, format: 'text', body: 'image/png · 6 bytes' },
      { label: 'IMAGE', name: null, format: 'text', body: 'image · 3,000 bytes' },
      { label: 'IMAGE', name: null, format: 'text', body: 'image/jpeg' },
    ])
  })

  it('writes a value JSON cannot hold as its text', () => {
    const blocks = response_view(turn({ response: [{ type: 'tool_call', name: 'n', input: 10n }, { type: 'tool_call', name: 'u' }] }))
    expect(blocks?.map((b) => b.body)).toStrictEqual(['10', 'undefined'])
  })

  it('is null when the log holds no reply', () => {
    expect(response_view(turn())).toBeNull()
    expect(response_view(turn({ response: [] }))).toStrictEqual([])
  })
})

describe('fold_text', () => {
  const lines = (count: number, width = 10): string =>
    Array.from({ length: count }, (_, i) => `${String(i).padStart(2, '0')}${'x'.repeat(width - 2)}`).join('\n')

  it('shows a short text whole', () => {
    expect(fold_text('hello')).toStrictEqual({ head: 'hello', more: null })
    expect(fold_text('')).toStrictEqual({ head: '', more: null })
  })

  it('shows a text of exactly the line and length limits whole', () => {
    expect(fold_text(lines(FOLD_LINES)).more).toBeNull()
    expect(fold_text('y'.repeat(FOLD_CHARS)).more).toBeNull()
  })

  it('keeps the first lines of a text with too many, and counts the rest', () => {
    const text = lines(FOLD_LINES + 1)
    expect(fold_text(text)).toStrictEqual({
      head: text.split('\n').slice(0, KEEP_LINES).join('\n'),
      more: `+${FOLD_LINES + 1 - KEEP_LINES} LINES`,
    })
    expect(fold_text(lines(40)).more).toBe(`+${40 - KEEP_LINES} LINES`)
  })

  it('keeps the first characters of a long text without many lines', () => {
    const text = 'y'.repeat(FOLD_CHARS + 1)
    expect(fold_text(text)).toStrictEqual({ head: 'y'.repeat(KEEP_CHARS), more: `+${FOLD_CHARS + 1 - KEEP_CHARS} CHARS` })
    expect(fold_text('z'.repeat(2000)).more).toBe('+1,520 CHARS')
  })

  it('folds by length when the kept lines would still run long', () => {
    const wide = lines(FOLD_LINES + 1, 120)
    expect(fold_text(wide)).toStrictEqual({ head: wide.slice(0, KEEP_CHARS), more: `+${grouped_count(wide.length - KEEP_CHARS)} CHARS` })
  })

  it('folds by lines when the kept lines fit the length exactly', () => {
    // Five lines of 95 characters and their four breaks come to 479; one more character reaches 480.
    const exact = ['w'.repeat(96), ...Array.from({ length: FOLD_LINES }, () => 'w'.repeat(95))].join('\n')
    expect(exact.split('\n').slice(0, KEEP_LINES).join('\n')).toHaveLength(KEEP_CHARS)
    expect(fold_text(exact).more).toBe(`+${FOLD_LINES + 1 - KEEP_LINES} LINES`)
  })
})

/** A count as `fold_text` writes it. */
function grouped_count(count: number): string {
  return count.toLocaleString('en-US')
}

describe('drawer_width', () => {
  it('takes its share of a narrow window and stops at its widest', () => {
    expect(drawer_width(1000)).toBe(Math.round(1000 * DRAWER_SHARE))
    expect(drawer_width(1001)).toBe(561)
    expect(drawer_width(1440)).toBe(806)
    expect(drawer_width(2000)).toBe(DRAWER_MAX_WIDTH)
    expect(drawer_width(DRAWER_MAX_WIDTH / DRAWER_SHARE)).toBe(DRAWER_MAX_WIDTH)
  })
})

describe('drawer_view', () => {
  const by_node = new Map([['plan_trip', [turn()]]])
  const labels = [
    { id: 'sequence_1', label: 'sequence' },
    { id: 'plan_trip', label: 'Plan the trip' },
  ]

  it('shows the open node by its label, with its turns, at the drawer width', () => {
    expect(drawer_view('plan_trip', by_node, labels, 1440)).toStrictEqual({
      name: 'Plan the trip',
      turns: by_node.get('plan_trip'),
      width: 806,
    })
  })

  it('falls back to the node id when no glyph carries it', () => {
    expect(drawer_view('plan_trip', by_node, [], 1000)?.name).toBe('plan_trip')
  })

  it('shows nothing when no node is open, or the open one has no turns yet', () => {
    expect(drawer_view(null, by_node, labels, 1440)).toBeNull()
    expect(drawer_view('sequence_1', by_node, labels, 1440)).toBeNull()
  })
})

describe('turns_badge', () => {
  it('centers the chip under the meta line, its word fitted inside the padding', () => {
    const badge = turns_badge({ x: 200, y: 100 }, 3)
    expect(badge.label).toBe('3 TURNS')
    const advance = 9.5 * 0.74
    const text_length = 7 * advance - 9.5 * 0.14
    expect(badge.text_length).toBeCloseTo(text_length, 10)
    expect(badge.width).toBeCloseTo(text_length + 14, 10)
    expect(badge.x).toBeCloseTo(200 - (text_length + 14) / 2, 10)
    expect(badge.text_x).toBeCloseTo(200 - text_length / 2, 10)
    expect(badge.y).toBe(106)
    expect(badge.height).toBe(15)
    expect(badge.text_y).toBe(116.5)
  })

  it('widens with its word', () => {
    expect(turns_badge({ x: 0, y: 0 }, 1).label).toBe('1 TURN')
    expect(turns_badge({ x: 0, y: 0 }, 12).width - turns_badge({ x: 0, y: 0 }, 3).width).toBeCloseTo(9.5 * 0.74, 10)
  })
})
