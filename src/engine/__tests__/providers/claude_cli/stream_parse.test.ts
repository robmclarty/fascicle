/**
 * JSON-lines stream parser tests (spec §7, §12 #3, #4, #5, #8, #9, #27, #28; F24).
 *
 * Covers line buffering across partial chunks, malformed-JSON tolerance,
 * unknown event tolerance, step_index transitions on new assistant events
 * after tool_result, atomic tool_call_start + tool_call_end emission, and
 * the full event-to-StreamChunk mapping table from spec §7.2.
 */

import { describe, expect, it } from 'vitest'
import {
  create_parser_state,
  feed_chunk,
  flush_remaining,
  snapshot,
} from '../../../providers/claude_cli/stream_parse.js'
import type { StreamChunk } from '../../../types.js'
import { create_captured_trajectory } from './fixtures/mock_helpers.js'

type ParsedOutcome = {
  chunks: StreamChunk[]
  state: ReturnType<typeof create_parser_state>
  parsed: ReturnType<typeof snapshot>
}

async function feed(
  lines: ReadonlyArray<string>,
  trajectory?: ReturnType<typeof create_captured_trajectory>,
): Promise<ParsedOutcome> {
  const state = create_parser_state()
  const chunks: StreamChunk[] = []
  for (const line of lines) {
    await feed_chunk(state, `${line}\n`, chunks, undefined, trajectory?.logger)
  }
  await flush_remaining(state, chunks, undefined, trajectory?.logger)
  return { chunks, state, parsed: snapshot(state) }
}

function jline(obj: unknown): string {
  return JSON.stringify(obj)
}

const init_event = {
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
  model: 'mock',
}

function result_event(extras: Record<string, unknown> = {}): unknown {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'sess-1',
    duration_ms: 12,
    total_cost_usd: 0.01,
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 5 },
    result: '',
    ...extras,
  }
}

describe('spec §7.2 — event-to-StreamChunk mapping', () => {
  it('§12 #8 — assistant text yields a text chunk', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi there' }] },
      }),
      jline(result_event({ result: 'hi there' })),
    ])
    const text_chunks = chunks.filter((c) => c.kind === 'text')
    expect(text_chunks.length).toBe(1)
    expect(text_chunks[0]).toEqual({
      kind: 'text',
      text: 'hi there',
      step_index: 0,
    })
  })

  it('§12 #3 — assistant tool_use emits tool_call_start followed by tool_call_end atomically', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: '/a' } },
          ],
        },
      }),
      jline(result_event()),
    ])
    const tc_start = chunks.find((c) => c.kind === 'tool_call_start')
    const tc_end = chunks.find((c) => c.kind === 'tool_call_end')
    expect(tc_start).toBeDefined()
    expect(tc_end).toBeDefined()
    if (tc_start?.kind === 'tool_call_start') {
      expect(tc_start.id).toBe('tu-1')
      expect(tc_start.name).toBe('Read')
    }
    if (tc_end?.kind === 'tool_call_end') {
      expect(tc_end.input).toEqual({ path: '/a' })
    }
    expect(chunks).not.toContainEqual(
      expect.objectContaining({ kind: 'tool_call_input_delta' }),
    )
  })

  it('user tool_result yields a tool_result chunk with output', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Read', input: {} },
          ],
        },
      }),
      jline({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file body' },
          ],
        },
      }),
      jline(result_event()),
    ])
    const tr = chunks.find((c) => c.kind === 'tool_result')
    expect(tr?.kind).toBe('tool_result')
    if (tr?.kind === 'tool_result') {
      expect(tr.id).toBe('tu-1')
      expect(tr.output).toBe('file body')
      expect(tr.error).toBeUndefined()
    }
  })

  it('user tool_result with is_error yields an error chunk without output', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-2', name: 'Read', input: {} }],
        },
      }),
      jline({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-2',
              content: 'permission denied',
              is_error: true,
            },
          ],
        },
      }),
      jline(result_event()),
    ])
    const tr = chunks.find((c) => c.kind === 'tool_result' && c.id === 'tu-2')
    expect(tr).toBeDefined()
    if (tr?.kind === 'tool_result') {
      expect(tr.error?.message).toBe('permission denied')
      expect(tr.output).toBeUndefined()
    }
  })

  it('result event emits a finish chunk with usage', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }),
      jline(result_event()),
    ])
    const finish = chunks.find((c) => c.kind === 'finish')
    expect(finish).toBeDefined()
    if (finish?.kind === 'finish') {
      expect(finish.finish_reason).toBe('stop')
      expect(finish.usage.input_tokens).toBe(10)
      expect(finish.usage.output_tokens).toBe(5)
    }
  })

  it('system init records cli_session_started in trajectory', async () => {
    const trajectory = create_captured_trajectory()
    await feed([jline(init_event), jline(result_event())], trajectory)
    const started = trajectory.events.filter((e) => e.kind === 'cli_session_started')
    expect(started.length).toBe(1)
    expect(started[0]?.['session_id']).toBe('sess-1')
    expect(started[0]?.['model']).toBe('mock')
  })
})

describe('step_index transitions', () => {
  it('§12 #4 — new assistant after user tool_result emits step_finish and increments step_index', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }],
        },
      }),
      jline({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'x' }],
        },
      }),
      jline({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'follow-up' }] },
      }),
      jline(result_event()),
    ])
    const step_finishes = chunks.filter((c) => c.kind === 'step_finish')
    expect(step_finishes.length).toBe(1)
    if (step_finishes[0]?.kind === 'step_finish') {
      expect(step_finishes[0].step_index).toBe(0)
    }
    const follow_up_text = chunks.find(
      (c) => c.kind === 'text' && c.text === 'follow-up',
    )
    expect(follow_up_text).toBeDefined()
    if (follow_up_text?.kind === 'text') {
      expect(follow_up_text.step_index).toBe(1)
    }
  })
})

describe('§7.4 — tolerance', () => {
  it('§12 #9, F24 — malformed JSON lines record cli_parse_error and continue', async () => {
    const trajectory = create_captured_trajectory()
    const { parsed } = await feed(
      [
        jline(init_event),
        'not-json',
        jline({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        }),
        jline(result_event({ result: 'ok' })),
      ],
      trajectory,
    )
    const parse_errors = trajectory.events.filter((e) => e.kind === 'cli_parse_error')
    expect(parse_errors.length).toBe(1)
    expect(parse_errors[0]?.['line']).toBe('not-json')
    expect(parsed.received_result).toBe(true)
  })

  it('unknown type records cli_unknown_event and continues', async () => {
    const trajectory = create_captured_trajectory()
    const { parsed } = await feed(
      [
        jline(init_event),
        jline({ type: 'future_kind', data: {} }),
        jline(result_event()),
      ],
      trajectory,
    )
    const unknowns = trajectory.events.filter((e) => e.kind === 'cli_unknown_event')
    expect(unknowns.length).toBe(1)
    expect(parsed.received_result).toBe(true)
  })

  it('rate_limit_event records cli_rate_limit_event, not cli_unknown_event', async () => {
    const trajectory = create_captured_trajectory()
    const { parsed, chunks } = await feed(
      [
        jline(init_event),
        jline({
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'allowed',
            resetsAt: 1778387400,
            rateLimitType: 'five_hour',
            overageStatus: 'allowed',
            overageResetsAt: 1778383200,
            isUsingOverage: false,
          },
          uuid: 'b84ebf41-4d55-49a1-971b-95a85db121d2',
          session_id: 'sess-1',
        }),
        jline({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'ok' }] },
        }),
        jline(result_event({ result: 'ok' })),
      ],
      trajectory,
    )
    expect(
      trajectory.events.filter((e) => e.kind === 'cli_unknown_event').length,
    ).toBe(0)
    const rate_limits = trajectory.events.filter(
      (e) => e.kind === 'cli_rate_limit_event',
    )
    expect(rate_limits.length).toBe(1)
    const rl = rate_limits[0]
    expect(rl?.['session_id']).toBe('sess-1')
    expect(rl?.['status']).toBe('allowed')
    expect(rl?.['rate_limit_type']).toBe('five_hour')
    expect(rl?.['resets_at']).toBe(1778387400)
    expect(rl?.['overage_status']).toBe('allowed')
    expect(rl?.['overage_resets_at']).toBe(1778383200)
    expect(rl?.['is_using_overage']).toBe(false)
    expect(parsed.received_result).toBe(true)
    expect(parsed.final_text).toBe('ok')
    expect(chunks.filter((c) => c.kind === 'text').length).toBe(1)
  })

  it('rate_limit_event with missing rate_limit_info still records and does not crash', async () => {
    const trajectory = create_captured_trajectory()
    const { parsed } = await feed(
      [
        jline(init_event),
        jline({ type: 'rate_limit_event' }),
        jline(result_event()),
      ],
      trajectory,
    )
    expect(
      trajectory.events.filter((e) => e.kind === 'cli_rate_limit_event').length,
    ).toBe(1)
    expect(
      trajectory.events.filter((e) => e.kind === 'cli_unknown_event').length,
    ).toBe(0)
    expect(parsed.received_result).toBe(true)
  })

  it('empty or whitespace lines are ignored silently', async () => {
    const trajectory = create_captured_trajectory()
    const { parsed } = await feed(
      ['', '   ', jline(init_event), jline(result_event())],
      trajectory,
    )
    expect(
      trajectory.events.filter((e) => e.kind === 'cli_parse_error').length,
    ).toBe(0)
    expect(parsed.received_result).toBe(true)
  })

  it('non-object JSON (number, string) records cli_unknown_event', async () => {
    const trajectory = create_captured_trajectory()
    await feed(['42', '"hello"', jline(result_event())], trajectory)
    const unknowns = trajectory.events.filter((e) => e.kind === 'cli_unknown_event')
    expect(unknowns.length).toBe(2)
  })

  it('rejects assistant event with malformed message object as cli_unknown_event', async () => {
    const trajectory = create_captured_trajectory()
    const { parsed } = await feed(
      [
        jline(init_event),
        jline({ type: 'assistant', message: 'not-an-object' }),
        jline({ type: 'assistant', message: { content: 'not-an-array' } }),
        jline(result_event()),
      ],
      trajectory,
    )
    const unknowns = trajectory.events.filter((e) => e.kind === 'cli_unknown_event')
    expect(unknowns.length).toBe(2)
    expect(parsed.received_result).toBe(true)
  })

  it('silently drops assistant content entries with unknown type or missing required fields', async () => {
    const trajectory = create_captured_trajectory()
    const { chunks } = await feed(
      [
        jline(init_event),
        jline({
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'kept' },
              { type: 'future_part', data: 'x' },
              { type: 'tool_use', name: 'Read', input: {} },
              { type: 'text' },
              { type: 'tool_use', id: 'tu-1', name: 'Read', input: { p: 'ok' } },
            ],
          },
        }),
        jline(result_event({ result: 'kept' })),
      ],
      trajectory,
    )
    const texts = chunks.filter((c) => c.kind === 'text')
    const tool_starts = chunks.filter((c) => c.kind === 'tool_call_start')
    expect(texts.length).toBe(1)
    expect(tool_starts.length).toBe(1)
    expect(
      trajectory.events.filter((e) => e.kind === 'cli_unknown_event').length,
    ).toBe(0)
  })
})

describe('§7.3 — event-level strictness (a mistyped field rejects the whole event)', () => {
  // Characterization: each malformed event must be recorded as one
  // cli_unknown_event, never partially accepted. A trailing valid result event
  // keeps the stream well-formed so only the bad line is counted.
  const rejected: ReadonlyArray<readonly [string, unknown]> = [
    ['system subtype non-string', { type: 'system', subtype: 1 }],
    ['system session_id non-string', { type: 'system', session_id: 1 }],
    ['system model non-string', { type: 'system', model: 1 }],
    ['result subtype non-string', { type: 'result', subtype: 1 }],
    ['result session_id non-string', { type: 'result', session_id: 1 }],
    ['result total_cost_usd non-number', { type: 'result', total_cost_usd: 'x' }],
    ['result duration_ms non-number', { type: 'result', duration_ms: 'x' }],
    ['result is_error non-boolean', { type: 'result', is_error: 'x' }],
    ['result result non-string', { type: 'result', result: 1 }],
    ['result usage null', { type: 'result', usage: null }],
    ['result usage array', { type: 'result', usage: [] }],
    ['result usage input_tokens non-number', { type: 'result', usage: { input_tokens: 'x' } }],
    ['result usage output_tokens non-number', { type: 'result', usage: { output_tokens: 'x' } }],
    ['result usage cache_read non-number', { type: 'result', usage: { cache_read_input_tokens: 'x' } }],
    ['result usage cache_creation non-number', { type: 'result', usage: { cache_creation_input_tokens: 'x' } }],
    ['rate_limit session_id non-string', { type: 'rate_limit_event', session_id: 1 }],
    ['rate_limit info non-object', { type: 'rate_limit_event', rate_limit_info: 'x' }],
    ['rate_limit info array', { type: 'rate_limit_event', rate_limit_info: [] }],
    ['rate_limit info status non-string', { type: 'rate_limit_event', rate_limit_info: { status: 1 } }],
    ['rate_limit info resetsAt non-number', { type: 'rate_limit_event', rate_limit_info: { resetsAt: 'x' } }],
    ['rate_limit info rateLimitType non-string', { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 1 } }],
    ['rate_limit info overageStatus non-string', { type: 'rate_limit_event', rate_limit_info: { overageStatus: 1 } }],
    ['rate_limit info overageResetsAt non-number', { type: 'rate_limit_event', rate_limit_info: { overageResetsAt: 'x' } }],
    ['rate_limit info isUsingOverage non-boolean', { type: 'rate_limit_event', rate_limit_info: { isUsingOverage: 'x' } }],
    ['assistant message null', { type: 'assistant', message: null }],
    ['user message null', { type: 'user', message: null }],
    ['user message non-object', { type: 'user', message: 'x' }],
    ['user message content non-array', { type: 'user', message: { content: 'x' } }],
    ['top-level array', [1, 2]],
    ['top-level null', null],
  ]
  it.each(rejected)('%s records exactly one cli_unknown_event', async (_label, event) => {
    const trajectory = create_captured_trajectory()
    const { parsed } = await feed(
      [jline(init_event), jline(event), jline(result_event())],
      trajectory,
    )
    expect(
      trajectory.events.filter((e) => e.kind === 'cli_unknown_event').length,
    ).toBe(1)
    // the trailing valid result still lands, proving only the bad line was dropped
    expect(parsed.received_result).toBe(true)
  })

  it('unknown top-level and usage keys are ignored, not rejected', async () => {
    const { parsed, chunks } = await feed([
      jline(init_event),
      jline(
        result_event({
          unexpected_field: 'ok',
          usage: { input_tokens: 3, output_tokens: 1, future_token_kind: 9 },
        }),
      ),
    ])
    expect(parsed.received_result).toBe(true)
    expect(chunks.filter((c) => c.kind === 'finish').length).toBe(1)
    expect(parsed.final_usage.input_tokens).toBe(3)
    expect(parsed.final_usage.output_tokens).toBe(1)
  })
})

describe('§7.4 — content entries drop individually without rejecting the event', () => {
  const dropped_assistant: ReadonlyArray<readonly [string, unknown]> = [
    ['text with non-string text', { type: 'text', text: 1 }],
    ['tool_use missing id', { type: 'tool_use', name: 'n', input: {} }],
    ['tool_use non-string id', { type: 'tool_use', id: 1, name: 'n', input: {} }],
    ['tool_use missing name', { type: 'tool_use', id: 'i', input: {} }],
    ['tool_use non-string name', { type: 'tool_use', id: 'i', name: 1, input: {} }],
    ['unknown part type', { type: 'future_part', data: 1 }],
    // an unknown type is dropped even when it carries otherwise-valid id/name:
    // the `type` gate, not the fields, is what admits a tool_use.
    ['unknown type carrying id and name', { type: 'future_part', id: 'x', name: 'n', input: {} }],
    ['non-object entry', 42],
    ['null entry', null],
  ]
  it.each(dropped_assistant)(
    'assistant content: %s is dropped, keeping its valid sibling',
    async (_label, bad) => {
      const trajectory = create_captured_trajectory()
      const { chunks } = await feed(
        [
          jline(init_event),
          jline({
            type: 'assistant',
            message: { content: [bad, { type: 'text', text: 'kept' }] },
          }),
          jline(result_event({ result: 'kept' })),
        ],
        trajectory,
      )
      expect(chunks.filter((c) => c.kind === 'text').length).toBe(1)
      expect(chunks.filter((c) => c.kind === 'tool_call_start').length).toBe(0)
      expect(
        trajectory.events.filter((e) => e.kind === 'cli_unknown_event').length,
      ).toBe(0)
    },
  )

  const dropped_user: ReadonlyArray<readonly [string, unknown]> = [
    ['missing tool_use_id', { type: 'tool_result', content: 'x' }],
    ['non-string tool_use_id', { type: 'tool_result', tool_use_id: 1, content: 'x' }],
    ['non-boolean is_error', { type: 'tool_result', tool_use_id: 't', is_error: 'x' }],
    ['non-tool_result type', { type: 'text', text: 'x' }],
    // a non-tool_result entry is dropped even when it carries a valid
    // tool_use_id: the `type` gate is what admits a tool result.
    ['non-tool_result type carrying tool_use_id', { type: 'text', tool_use_id: 't', content: 'x' }],
    ['non-object entry', 42],
    ['null entry', null],
  ]
  it.each(dropped_user)('user content: %s is dropped', async (_label, bad) => {
    const trajectory = create_captured_trajectory()
    const { chunks } = await feed(
      [
        jline(init_event),
        jline({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }] },
        }),
        jline({ type: 'user', message: { content: [bad] } }),
        jline(result_event()),
      ],
      trajectory,
    )
    expect(chunks.filter((c) => c.kind === 'tool_result').length).toBe(0)
    expect(
      trajectory.events.filter((e) => e.kind === 'cli_unknown_event').length,
    ).toBe(0)
  })

  it('a valid tool_result with an explicit is_error: false is kept as a success', async () => {
    const { chunks } = await feed([
      jline(init_event),
      jline({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: {} }] },
      }),
      jline({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'body', is_error: false }],
        },
      }),
      jline(result_event()),
    ])
    const tr = chunks.find((c) => c.kind === 'tool_result')
    expect(tr?.kind).toBe('tool_result')
    if (tr?.kind === 'tool_result') {
      expect(tr.output).toBe('body')
      expect(tr.error).toBeUndefined()
    }
  })
})

describe('line buffering across partial chunks', () => {
  it('§12 #27 — accumulates partial JSON across multiple feed_chunk calls', async () => {
    const state = create_parser_state()
    const chunks: StreamChunk[] = []
    const full = jline(init_event) + '\n' + jline(result_event()) + '\n'
    const mid = Math.floor(full.length / 2)
    await feed_chunk(state, full.slice(0, mid), chunks, undefined, undefined)
    await feed_chunk(state, full.slice(mid), chunks, undefined, undefined)
    await flush_remaining(state, chunks, undefined, undefined)
    const parsed = snapshot(state)
    expect(parsed.received_result).toBe(true)
  })

  it('final incomplete line without newline is flushed by flush_remaining', async () => {
    const state = create_parser_state()
    const chunks: StreamChunk[] = []
    const text =
      jline(init_event) + '\n' + jline({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial' }] },
      }) + '\n' + jline(result_event({ result: 'partial' }))
    await feed_chunk(state, text, chunks, undefined, undefined)
    await flush_remaining(state, chunks, undefined, undefined)
    const parsed = snapshot(state)
    expect(parsed.received_result).toBe(true)
    expect(parsed.final_text).toBe('partial')
  })
})

describe('on_chunk dispatch ordering', () => {
  it('§12 #5 — dispatches chunks to on_chunk in source order', async () => {
    const received: string[] = []
    const state = create_parser_state()
    const chunks: StreamChunk[] = []
    const dispatch = async (chunk: StreamChunk): Promise<void> => {
      received.push(chunk.kind)
    }
    const lines = [
      jline(init_event),
      jline({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
      jline(result_event({ result: 'hello' })),
    ]
    for (const line of lines) {
      await feed_chunk(state, `${line}\n`, chunks, dispatch, undefined)
    }
    expect(received).toEqual(['text', 'finish'])
  })
})

describe('usage mapping', () => {
  it('§12 #28 — maps cache_read_input_tokens -> cached_input_tokens and cache_creation_input_tokens -> cache_write_tokens', async () => {
    const { parsed } = await feed([
      jline(init_event),
      jline(
        result_event({
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 10,
          },
        }),
      ),
    ])
    expect(parsed.final_usage.input_tokens).toBe(100)
    expect(parsed.final_usage.output_tokens).toBe(20)
    expect(parsed.final_usage.cached_input_tokens).toBe(50)
    expect(parsed.final_usage.cache_write_tokens).toBe(10)
  })

  it('treats missing usage fields as zero (input_tokens, output_tokens)', async () => {
    const { parsed, chunks } = await feed([
      jline(init_event),
      jline({ type: 'result', subtype: 'success' }),
    ])
    // a result carrying no usage object is still a valid, accepted result
    expect(parsed.received_result).toBe(true)
    expect(chunks.filter((c) => c.kind === 'finish').length).toBe(1)
    expect(parsed.final_usage.input_tokens).toBe(0)
    expect(parsed.final_usage.output_tokens).toBe(0)
  })
})

describe('snapshot() exposes parsed result safely', () => {
  it('returns a shallow copy; subsequent mutation of internal state does not affect snapshot', async () => {
    const { state, parsed } = await feed([jline(init_event), jline(result_event())])
    const turn_count_before = parsed.turns.length
    state.turns.push({
      step_index: 99,
      text: 'x',
      tool_calls: [],
      tool_results: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    })
    expect(parsed.turns.length).toBe(turn_count_before)
  })
})
