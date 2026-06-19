import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  format_zod_error,
  parse_with_schema,
  throw_schema_validation,
} from '../schema.js'
import { schema_validation_error } from '../errors.js'

describe('format_zod_error', () => {
  it('returns "unknown error" for null and undefined', () => {
    expect(format_zod_error(null)).toBe('unknown error')
    expect(format_zod_error(undefined)).toBe('unknown error')
  })

  it('returns a string error as-is', () => {
    expect(format_zod_error('boom')).toBe('boom')
  })

  it('returns the message of an Error', () => {
    expect(format_zod_error(new Error('exploded'))).toBe('exploded')
  })

  it('returns a string message property of a plain object', () => {
    expect(format_zod_error({ message: 'plain message' })).toBe('plain message')
  })

  it('serializes an object whose message is not a string', () => {
    expect(format_zod_error({ message: 123 })).toBe('{"message":123}')
  })

  it('serializes an object with no message property', () => {
    expect(format_zod_error({ code: 'X', detail: 'Y' })).toBe('{"code":"X","detail":"Y"}')
  })

  it('serializes non-object primitives', () => {
    expect(format_zod_error(42)).toBe('42')
  })

  it('falls back to "unknown error" when serialization throws', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(format_zod_error(circular)).toBe('unknown error')
  })

  it('falls back to "unknown error" when JSON.stringify yields undefined', () => {
    // A function is not null/string/Error/object-with-message, and
    // JSON.stringify(fn) === undefined, so the ?? fallback must apply.
    expect(format_zod_error(() => undefined)).toBe('unknown error')
  })
})

describe('throw_schema_validation', () => {
  it('throws with a message that includes the formatted zod error', () => {
    try {
      throw_schema_validation(new Error('expected number'), 'raw')
      expect.unreachable('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(schema_validation_error)
      expect((err as schema_validation_error).message).toBe('schema validation failed: expected number')
    }
  })
})

describe('parse_with_schema edge cases', () => {
  const schema = z.object({ name: z.string() })

  it('reports a no-content error when the text has no JSON candidates', () => {
    const outcome = parse_with_schema(schema, '   ')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect((outcome.error as Error).message).toContain('No JSON-parseable content')
    }
  })

  it('surfaces the JSON parse error (not a schema error) when nothing parses', () => {
    // The catch must record the parse error and skip safeParse; otherwise a
    // ZodError from safeParse(undefined) would mask the real parse failure.
    const outcome = parse_with_schema(schema, 'totally not json')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect('issues' in (outcome.error as object)).toBe(false)
    }
  })

  it('extracts the outermost-brace slice from surrounding prose', () => {
    // The slice must include the closing brace and survive a leading offset
    // (a +1/-1 slip on the open index would drop or shift the slice).
    const outcome = parse_with_schema(schema, 'x{"name":"ada"}y')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value).toEqual({ name: 'ada' })
  })

  it('captures a whitespace-containing fenced block the brace-slice cannot recover', () => {
    // The leading {"wrong":true} makes the outermost-brace slice span past the
    // fence into invalid JSON, so only the fence capture works -- and that
    // capture must span the space inside the object.
    const text = '{"wrong":true}\n\n```json\n{"name": "ada"}\n```'
    const outcome = parse_with_schema(schema, text)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value).toEqual({ name: 'ada' })
  })

  it('keeps the outermost-brace slice intact (closing brace included)', () => {
    // A missing +1 in the slice would drop the final "}" and fail to parse.
    const outcome = parse_with_schema(schema, 'prefix {"name":"ada"} suffix')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value).toEqual({ name: 'ada' })
  })

  it('deduplicates identical candidates (bare JSON object)', () => {
    // text === its own outermost-brace slice; both must collapse to one
    // candidate, and a valid parse still succeeds.
    const outcome = parse_with_schema(schema, '{"name":"ada"}')
    expect(outcome.ok).toBe(true)
  })
})
