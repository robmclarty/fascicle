import { describe, expect, it } from 'vitest'
import {
  is_custom_trajectory_event,
  is_emit_event,
  is_span_end_event,
  is_span_start_event,
  parse_trajectory_event,
} from '../trajectory.js'
import type { ParsedTrajectoryEvent } from '../trajectory.js'

function parse_or_throw(value: unknown): ParsedTrajectoryEvent {
  const result = parse_trajectory_event(value)
  if (!result.success) throw result.error
  return result.data
}

describe('parse_trajectory_event', () => {
  it('parses a well-formed span_start as SpanStartEvent', () => {
    const wire = {
      kind: 'span_start',
      span_id: 'sequence:abcd',
      name: 'sequence',
      id: 'sequence_1',
      run_id: 'run-1',
    }
    const parsed = parse_or_throw(wire)
    expect(parsed.kind).toBe('span_start')
    expect(is_span_start_event(wire)).toBe(true)
    expect((parsed as { run_id?: string }).run_id).toBe('run-1')
  })

  it('parses a well-formed span_end as SpanEndEvent', () => {
    const wire = { kind: 'span_end', span_id: 'sequence:abcd', id: 'sequence_1' }
    const parsed = parse_or_throw(wire)
    expect(parsed.kind).toBe('span_end')
    expect(is_span_end_event(wire)).toBe(true)
  })

  it('parses a ctx.emit event as EmitEvent', () => {
    const wire = { kind: 'emit', whatever: 1 }
    const parsed = parse_or_throw(wire)
    expect(parsed.kind).toBe('emit')
    expect(is_emit_event(wire)).toBe(true)
  })

  it('falls back to custom for any unknown kind, preserving extra fields', () => {
    const wire = {
      kind: 'cost',
      step_index: 0,
      total_usd: 0.001,
      input_usd: 0.0005,
      output_usd: 0.0005,
    }
    const parsed = parse_or_throw(wire)
    expect(parsed.kind).toBe('cost')
    const as_custom = parsed as Record<string, unknown>
    expect(as_custom['step_index']).toBe(0)
    expect(as_custom['total_usd']).toBe(0.001)
  })

  it('round-trips every well-known shape via JSON without loss', () => {
    const samples: ParsedTrajectoryEvent[] = [
      { kind: 'span_start', span_id: 's:1', name: 'sequence', id: 'sequence_1', run_id: 'r-1' },
      { kind: 'span_end', span_id: 's:1', id: 'sequence_1', run_id: 'r-1' },
      { kind: 'emit', label: 'progress', value: 42, run_id: 'r-1' },
      { kind: 'cost', step_index: 0, total_usd: 0.001, run_id: 'r-1' },
      { kind: 'cli_session_started', session_id: 'abc', model: 'sonnet' },
    ]
    for (const original of samples) {
      const wire = JSON.stringify(original)
      const re_parsed = parse_or_throw(JSON.parse(wire))
      expect(re_parsed).toEqual(original)
    }
  })

  it('hands the parsed value back by reference rather than copying it', () => {
    const wire = { kind: 'emit', nested: { deep: true } }
    const result = parse_trajectory_event(wire)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toBe(wire)
  })

  it('rejects values that are not objects with a string kind', () => {
    for (const rejected of [null, undefined, 'string', 42, true, [], [{ kind: 'emit' }], {}]) {
      expect(parse_trajectory_event(rejected).success).toBe(false)
    }
    expect(parse_trajectory_event({ no_kind: true }).success).toBe(false)
    expect(parse_trajectory_event({ kind: 42 }).success).toBe(false)
    expect(parse_trajectory_event({ kind: undefined }).success).toBe(false)
  })

  it('reports a rejection as an Error naming the missing field', () => {
    const result = parse_trajectory_event({ no_kind: true })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toBeInstanceOf(Error)
    expect(result.error.message).toContain('kind')
  })

  it('accepts an event whose well-known kind is missing that kind’s fields', () => {
    // The wire gate is forward-compatible on purpose: a span_start line with no
    // span_id is still an event, it just is not a SpanStartEvent. A viewer that
    // dropped it would lose lines a newer producer emits.
    const wire = { kind: 'span_start' }
    expect(parse_trajectory_event(wire).success).toBe(true)
    expect(is_span_start_event(wire)).toBe(false)
    expect(is_custom_trajectory_event(wire)).toBe(true)
  })
})

describe('is_custom_trajectory_event', () => {
  it('is true for every well-known kind, since custom is the fallback shape', () => {
    expect(is_custom_trajectory_event({ kind: 'span_start', span_id: 's', name: 'n' })).toBe(true)
    expect(is_custom_trajectory_event({ kind: 'span_end', span_id: 's' })).toBe(true)
    expect(is_custom_trajectory_event({ kind: 'emit' })).toBe(true)
    expect(is_custom_trajectory_event({ kind: 'cost' })).toBe(true)
  })

  it('rejects a non-object carrying a kind', () => {
    // typeof 'function' is not 'object', so a callable with a kind is not an
    // event. Dropping the typeof clause would let this through.
    const callable = Object.assign(() => undefined, { kind: 'emit' })
    expect(is_custom_trajectory_event(callable)).toBe(false)
  })

  it('rejects an array carrying a kind', () => {
    // typeof [] is 'object' and the property is readable, so only the explicit
    // Array.isArray clause keeps this out.
    const array_with_kind = Object.assign([], { kind: 'emit' })
    expect(is_custom_trajectory_event(array_with_kind)).toBe(false)
  })

  it('rejects null without dereferencing it', () => {
    expect(is_custom_trajectory_event(null)).toBe(false)
  })

  it('rejects a kind that is present but not a string', () => {
    expect(is_custom_trajectory_event({ kind: 42 })).toBe(false)
    expect(is_custom_trajectory_event({ kind: null })).toBe(false)
    expect(is_custom_trajectory_event({ kind: { nested: true } })).toBe(false)
  })
})

describe('is_span_start_event', () => {
  it('requires the span_start kind', () => {
    expect(is_span_start_event({ kind: 'emit', span_id: 's', name: 'n' })).toBe(false)
    expect(is_span_start_event({ kind: 'span_end', span_id: 's', name: 'n' })).toBe(false)
  })

  it('requires a string span_id', () => {
    expect(is_span_start_event({ kind: 'span_start', name: 'n' })).toBe(false)
    expect(is_span_start_event({ kind: 'span_start', span_id: 1, name: 'n' })).toBe(false)
  })

  it('requires a string name', () => {
    expect(is_span_start_event({ kind: 'span_start', span_id: 's' })).toBe(false)
    expect(is_span_start_event({ kind: 'span_start', span_id: 's', name: 1 })).toBe(false)
  })

  it('rejects a non-event without dereferencing it', () => {
    expect(is_span_start_event(null)).toBe(false)
    expect(is_span_start_event('span_start')).toBe(false)
  })
})

describe('is_span_end_event', () => {
  it('requires the span_end kind and a string span_id', () => {
    expect(is_span_end_event({ kind: 'span_end', span_id: 's' })).toBe(true)
    expect(is_span_end_event({ kind: 'emit', span_id: 's' })).toBe(false)
    expect(is_span_end_event({ kind: 'span_end' })).toBe(false)
    expect(is_span_end_event({ kind: 'span_end', span_id: 1 })).toBe(false)
  })

  it('rejects a non-event without dereferencing it', () => {
    expect(is_span_end_event(null)).toBe(false)
  })
})

describe('is_emit_event', () => {
  it('is true for the emit kind alone, whatever the payload', () => {
    expect(is_emit_event({ kind: 'emit' })).toBe(true)
    expect(is_emit_event({ kind: 'emit', label: 'progress', value: 42 })).toBe(true)
  })

  it('is false for any other kind', () => {
    expect(is_emit_event({ kind: 'span_start', span_id: 's', name: 'n' })).toBe(false)
    expect(is_emit_event({ kind: 'cost' })).toBe(false)
  })

  it('rejects a non-event without dereferencing it', () => {
    expect(is_emit_event(null)).toBe(false)
  })
})
