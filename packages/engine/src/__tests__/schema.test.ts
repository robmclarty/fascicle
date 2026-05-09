import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  build_repair_message,
  build_repair_prompt_text,
  parse_with_schema,
  throw_schema_validation,
} from '../schema.js'
import { schema_validation_error } from '../errors.js'

const user_schema = z.object({ name: z.string(), age: z.number().int() })

describe('parse_with_schema', () => {
  it('returns ok: true on valid JSON matching the schema', () => {
    const outcome = parse_with_schema(user_schema, '{"name":"ada","age":36}')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.value).toEqual({ name: 'ada', age: 36 })
    }
  })

  it('returns ok: false on malformed JSON', () => {
    const outcome = parse_with_schema(user_schema, '{not json')
    expect(outcome.ok).toBe(false)
  })

  it('returns ok: false on schema mismatch', () => {
    const outcome = parse_with_schema(user_schema, '{"name":"ada","age":"thirty"}')
    expect(outcome.ok).toBe(false)
  })

  it('parses JSON wrapped in a ```json fence', () => {
    const fenced = '```json\n{"name":"ada","age":36}\n```'
    const outcome = parse_with_schema(user_schema, fenced)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value).toEqual({ name: 'ada', age: 36 })
  })

  it('parses JSON wrapped in a plain ``` fence (no language tag)', () => {
    const fenced = '```\n{"name":"ada","age":36}\n```'
    const outcome = parse_with_schema(user_schema, fenced)
    expect(outcome.ok).toBe(true)
  })

  it('parses JSON wrapped in a fence with surrounding whitespace', () => {
    const fenced = '\n\n```json\n{"name":"ada","age":36}\n```\n\n'
    const outcome = parse_with_schema(user_schema, fenced)
    expect(outcome.ok).toBe(true)
  })

  it('extracts JSON from a fenced block embedded in surrounding prose', () => {
    const messy =
      'Looking at the diff, here is the JSON:\n\n```json\n{"name":"ada","age":36}\n```\n\nHope that helps.'
    const outcome = parse_with_schema(user_schema, messy)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value).toEqual({ name: 'ada', age: 36 })
  })

  it('extracts JSON from unfenced prose via outermost-braces fallback', () => {
    const text = 'Here is the result: {"name":"ada","age":36} - end.'
    const outcome = parse_with_schema(user_schema, text)
    expect(outcome.ok).toBe(true)
  })

  it('handles top-level JSON arrays via the brackets fallback', () => {
    const list_schema = z.array(z.number().int())
    const messy = 'Three numbers: [1, 2, 3] - done.'
    const outcome = parse_with_schema(list_schema, messy)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value).toEqual([1, 2, 3])
  })

  it('prefers a schema-matching candidate even when an earlier one parses', () => {
    const text =
      'first I tried this: {"wrong": true}\n\n```json\n{"name":"ada","age":36}\n```'
    const outcome = parse_with_schema(user_schema, text)
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.value).toEqual({ name: 'ada', age: 36 })
  })

  it('returns ok: false when fenced content is itself invalid JSON', () => {
    const fenced = '```json\n{not json}\n```'
    const outcome = parse_with_schema(user_schema, fenced)
    expect(outcome.ok).toBe(false)
  })

  it('returns ok: false on prose with no JSON-parseable content', () => {
    const outcome = parse_with_schema(user_schema, 'I cannot answer that.')
    expect(outcome.ok).toBe(false)
  })
})

describe('build_repair_message', () => {
  it('produces a user-role message matching the canonical shape', () => {
    const message = build_repair_message(new Error('expected number, got string'))
    expect(message.role).toBe('user')
    expect(message.content as string).toContain('did not match the expected schema')
    expect(message.content as string).toContain('expected number, got string')
    expect(message.content as string).toContain('strictly conforms to the schema')
  })

  it('explicitly forbids markdown code fences and prose in the response', () => {
    const message = build_repair_message(new Error('boom'))
    expect(message.content as string).toContain('no markdown code fences')
    expect(message.content as string).toContain('no surrounding prose')
  })
})

describe('build_repair_prompt_text', () => {
  it('returns a string with the same content as build_repair_message', () => {
    const err = new Error('expected number, got string')
    expect(build_repair_prompt_text(err)).toBe(build_repair_message(err).content)
  })
})

describe('throw_schema_validation', () => {
  it('throws schema_validation_error with zod error and raw text', () => {
    const zerr = new Error('boom')
    try {
      throw_schema_validation(zerr, 'raw model output')
      expect.unreachable('should throw')
    } catch (err) {
      expect(err).toBeInstanceOf(schema_validation_error)
      expect((err as schema_validation_error).zod_error).toBe(zerr)
      expect((err as schema_validation_error).raw_text).toBe('raw model output')
    }
  })
})
