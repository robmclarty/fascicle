import { describe, expect, it } from 'vitest'
import { json_schema_to_standard } from '../schema_bridge.js'

async function accepts(schema: unknown, value: unknown): Promise<boolean> {
  const result = await json_schema_to_standard(schema)['~standard'].validate(value)
  return result.issues === undefined
}

function emitted(schema: unknown): Record<string, unknown> {
  return json_schema_to_standard(schema)['~standard'].jsonSchema.input({
    target: 'draft-2020-12',
  })
}

describe('json_schema_to_standard validation', () => {
  it('converts primitive types', async () => {
    expect(await accepts({ type: 'string' }, 'x')).toBe(true)
    expect(await accepts({ type: 'string' }, 1)).toBe(false)
    expect(await accepts({ type: 'number' }, 1.5)).toBe(true)
    expect(await accepts({ type: 'integer' }, 2)).toBe(true)
    expect(await accepts({ type: 'integer' }, 2.5)).toBe(false)
    expect(await accepts({ type: 'boolean' }, true)).toBe(true)
    expect(await accepts({ type: 'null' }, null)).toBe(true)
  })

  it('honors required vs optional object properties and keeps extra keys', async () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    }
    expect(await accepts(schema, { a: 'x' })).toBe(true)
    expect(await accepts(schema, { b: 1 })).toBe(false)
    // Loose objects pass unmodeled args through to the server, which re-validates.
    const parsed = await json_schema_to_standard(schema)['~standard'].validate({
      a: 'x',
      extra: true,
    })
    expect(parsed.issues).toBeUndefined()
    expect('value' in parsed && parsed.value).toEqual({ a: 'x', extra: true })
  })

  it('converts nested objects and arrays', async () => {
    const schema = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      },
      required: ['items', 'nested'],
    }
    expect(await accepts(schema, { items: ['a', 'b'], nested: { n: 1 } })).toBe(true)
    expect(await accepts(schema, { items: [1], nested: { n: 1 } })).toBe(false)
    expect(await accepts(schema, { items: [], nested: {} })).toBe(false)
  })

  it('converts enum, const, and unions', async () => {
    expect(await accepts({ enum: ['a', 'b'] }, 'a')).toBe(true)
    expect(await accepts({ enum: ['a', 'b'] }, 'c')).toBe(false)
    expect(await accepts({ const: 42 }, 42)).toBe(true)
    expect(await accepts({ const: 42 }, 43)).toBe(false)
    const u = { anyOf: [{ type: 'string' }, { type: 'number' }] }
    expect(await accepts(u, 'x')).toBe(true)
    expect(await accepts(u, 1)).toBe(true)
    expect(await accepts(u, true)).toBe(false)
  })

  it('intersects allOf members', async () => {
    const schema = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    }
    expect(await accepts(schema, { a: 'x', b: 1 })).toBe(true)
    expect(await accepts(schema, { a: 'x' })).toBe(false)
  })

  it('treats a mixed-type enum as a union of literals', async () => {
    const schema = { enum: ['on', 1, true] }
    expect(await accepts(schema, 'on')).toBe(true)
    expect(await accepts(schema, 1)).toBe(true)
    expect(await accepts(schema, true)).toBe(true)
    expect(await accepts(schema, 'off')).toBe(false)
  })

  it('unwraps a single-member union', async () => {
    const schema = { anyOf: [{ type: 'boolean' }] }
    expect(await accepts(schema, true)).toBe(true)
    expect(await accepts(schema, 'x')).toBe(false)
  })

  it('supports boolean and null const', async () => {
    expect(await accepts({ const: true }, true)).toBe(true)
    expect(await accepts({ const: true }, false)).toBe(false)
    expect(await accepts({ const: null }, null)).toBe(true)
  })

  it('accepts an array of objects', async () => {
    const schema = {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    }
    expect(await accepts(schema, [{ id: 1 }, { id: 2 }])).toBe(true)
    expect(await accepts(schema, [{ id: 'x' }])).toBe(false)
  })

  it('handles the array type form for nullable', async () => {
    const schema = { type: ['string', 'null'] }
    expect(await accepts(schema, 'x')).toBe(true)
    expect(await accepts(schema, null)).toBe(true)
    expect(await accepts(schema, 1)).toBe(false)
  })

  it('handles a single-entry array type form', async () => {
    const schema = { type: ['integer'] }
    expect(await accepts(schema, 3)).toBe(true)
    expect(await accepts(schema, 3.5)).toBe(false)
  })

  it('degrades to a permissive type for unrecognized constructs', async () => {
    // A $ref/vendor construct it cannot model must never reject a valid arg.
    const schema = { $ref: '#/definitions/Thing' }
    expect(await accepts(schema, { anything: 1 })).toBe(true)
    expect(await accepts(schema, 'string')).toBe(true)
    expect(await accepts(schema, null)).toBe(true)
  })

  it('never throws on malformed input', async () => {
    expect(() => json_schema_to_standard(null)).not.toThrow()
    expect(() => json_schema_to_standard(42)).not.toThrow()
    expect(await accepts(null, { x: 1 })).toBe(true)
  })

  it('returns a permissive schema when reading the advertised schema throws', async () => {
    // A schema whose property access throws must be caught, not propagated:
    // tool discovery cannot crash on a hostile remote schema.
    const hostile = {
      get type(): string {
        throw new Error('boom')
      },
    }
    expect(await accepts(hostile, { anything: 1 })).toBe(true)
    expect(emitted(hostile)).toEqual({})
  })

  it('returns a permissive schema when the advertised schema is cyclic', async () => {
    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic['properties'] = { self: cyclic }
    expect(await accepts(cyclic, 'not an object')).toBe(true)
    expect(emitted(cyclic)).toEqual({})
  })

  it('degrades an unrecognized type keyword to a permissive schema', async () => {
    const schema = { type: 'bogus-type' }
    expect(await accepts(schema, 'x')).toBe(true)
    expect(await accepts(schema, { any: 1 })).toBe(true)
  })

  it('treats oneOf as a union', async () => {
    const schema = { oneOf: [{ type: 'string' }, { type: 'number' }] }
    expect(await accepts(schema, 'x')).toBe(true)
    expect(await accepts(schema, 1)).toBe(true)
    expect(await accepts(schema, true)).toBe(false)
  })

  it('treats a typeless schema with properties as an object', async () => {
    const schema = { properties: { a: { type: 'string' } }, required: ['a'] }
    expect(await accepts(schema, { a: 'x' })).toBe(true)
    expect(await accepts(schema, { a: 1 })).toBe(false)
    expect(await accepts(schema, {})).toBe(false)
  })

  it('accepts anything for an empty enum', async () => {
    expect(await accepts({ enum: [] }, 'x')).toBe(true)
  })

  it('accepts anything for an empty anyOf', async () => {
    expect(await accepts({ anyOf: [] }, 'x')).toBe(true)
  })

  it('accepts anything for an empty allOf and an empty type list', async () => {
    expect(await accepts({ allOf: [] }, 'x')).toBe(true)
    expect(await accepts({ type: [] }, 'x')).toBe(true)
  })

  it('matches only null for a null const and rejects other values', async () => {
    expect(await accepts({ const: null }, null)).toBe(true)
    expect(await accepts({ const: null }, 'x')).toBe(false)
  })

  it('stays permissive for a const whose value is not a primitive', async () => {
    // Object/array consts are not matched structurally, so they degrade to an
    // accept-anything check rather than a null- or literal-shaped one.
    expect(await accepts({ const: { a: 1 } }, 'x')).toBe(true)
  })

  it('accepts a permissive array for tuple-style items', async () => {
    const schema = { type: 'array', items: [{ type: 'string' }, { type: 'number' }] }
    expect(await accepts(schema, ['a', 1])).toBe(true)
    expect(await accepts(schema, [1, 'a', true])).toBe(true)
  })

  it('rejects a non-object where an object is declared, and a non-array for an array', async () => {
    expect(await accepts({ type: 'object', properties: {} }, [])).toBe(false)
    expect(await accepts({ type: 'object', properties: {} }, null)).toBe(false)
    expect(await accepts({ type: 'array', items: { type: 'string' } }, {})).toBe(false)
  })

  it('rejects NaN and infinities for a number, matching what survives JSON', async () => {
    expect(await accepts({ type: 'number' }, Number.NaN)).toBe(false)
    expect(await accepts({ type: 'number' }, Number.POSITIVE_INFINITY)).toBe(false)
    expect(await accepts({ type: 'integer' }, Number.NaN)).toBe(false)
  })

  it('does not enforce a required name that has no declared property', async () => {
    // There is nothing to check it against, and rejecting an arg the server
    // would accept is the one failure mode this bridge must not have.
    expect(await accepts({ type: 'object', required: ['a'] }, {})).toBe(true)
  })

  it('reports the dotted path to a nested failure', async () => {
    const result = await json_schema_to_standard({
      type: 'object',
      properties: {
        opts: {
          type: 'object',
          properties: { list: { type: 'array', items: { type: 'string' } } },
          required: ['list'],
        },
      },
      required: ['opts'],
    })['~standard'].validate({ opts: { list: ['ok', 7] } })

    expect(result.issues).toEqual([
      { message: 'expected string, received number', path: ['opts', 'list', 1] },
    ])
  })

  it('reports a missing required key at that key, and a root failure with no path', async () => {
    const missing = await json_schema_to_standard({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    })['~standard'].validate({})
    expect(missing.issues).toEqual([{ message: 'required', path: ['a'] }])

    const root = await json_schema_to_standard({ type: 'string' })['~standard'].validate(1)
    expect(root.issues).toEqual([{ message: 'expected string, received number' }])
  })
})

describe('json_schema_to_standard emission', () => {
  it('emits the server schema verbatim, in both directions', () => {
    // The whole point of the step: no round trip, so the constraints a Zod
    // conversion dropped (minLength, format, pattern) reach the model intact.
    const server = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        city: { type: 'string', description: 'A city name', minLength: 1 },
        when: { type: 'string', format: 'date-time' },
        code: { type: 'string', pattern: '^[A-Z]{3}$' },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      },
      required: ['city'],
      additionalProperties: false,
    }
    const standard = json_schema_to_standard(server)['~standard']

    expect(standard.jsonSchema.input({ target: 'draft-2020-12' })).toEqual(server)
    expect(standard.jsonSchema.output({ target: 'draft-2020-12' })).toEqual(server)
  })

  it('emits verbatim whatever the target, since fascicle applies no transform', () => {
    const server = { type: 'object', properties: { a: { type: 'string' } } }
    const standard = json_schema_to_standard(server)['~standard']
    expect(standard.jsonSchema.input({ target: 'draft-07' })).toEqual(server)
    expect(standard.jsonSchema.input({ target: 'openapi-3.0' })).toEqual(server)
  })

  it('emits a freeform object as {type:object}, not the empty schema', () => {
    // z.unknown() would emit {} and starve the provider of the parameter shape.
    expect(emitted({ type: 'object' })).toEqual({ type: 'object' })
  })

  it('emits the empty schema for an advertisement that is not an object', () => {
    expect(emitted(null)).toEqual({})
    expect(emitted(42)).toEqual({})
  })

  it('hands out a fresh copy each call, so a mutating consumer cannot rewrite it', () => {
    // The AI SDK stamps `additionalProperties: false` onto the emitted schema in
    // place; a shared object would stop being verbatim after the first turn.
    const server = { type: 'object', properties: { a: { type: 'string' } } }
    const standard = json_schema_to_standard(server)['~standard']

    const first = standard.jsonSchema.input({ target: 'draft-2020-12' })
    first['additionalProperties'] = false
    const properties = first['properties']
    if (properties !== null && typeof properties === 'object') {
      ;(properties as Record<string, unknown>)['a'] = { type: 'number' }
    }

    expect(standard.jsonSchema.input({ target: 'draft-2020-12' })).toEqual(server)
    expect(server).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
  })

  it('does not alias the advertised schema, so a later server-side edit cannot leak in', () => {
    const server: Record<string, unknown> = { type: 'object' }
    const standard = json_schema_to_standard(server)['~standard']
    server['type'] = 'string'
    expect(standard.jsonSchema.input({ target: 'draft-2020-12' })).toEqual({ type: 'object' })
  })
})
