import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { schema_not_convertible_error, to_json_schema } from '#schema'
import type { ToolSchema } from '#schema'

const user_schema = z.object({ name: z.string(), age: z.number().int().default(3) })

/**
 * A vendor that implements Standard Schema but not Standard JSON Schema, which
 * is legal and is exactly the case `to_json_schema` has to explain. The cast is
 * the point: the type forbids this, and the guard exists for the runtime where
 * the type does not reach.
 */
const validate_only_vendor = {
  '~standard': {
    version: 1,
    vendor: 'validate-only-vendor',
    validate: (value: unknown) => ({ value }),
  },
} as unknown as ToolSchema

/** A vendor emitting exactly the JSON Schema given, in both directions. */
function fixed_vendor(json: Record<string, unknown>): ToolSchema {
  return {
    '~standard': {
      version: 1,
      vendor: 'fixed-vendor',
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => json, output: () => json },
    },
  }
}

describe('to_json_schema', () => {
  it('emits bytes identical to plain output-io wherever no field carries a default', () => {
    // The composed emission differs from the output direction only in which
    // fields it requires, so every schema without a default or a catch is
    // unchanged on the wire, key order included. This is what keeps the
    // provider payload tests below stable.
    const plain = z.object({ city: z.string(), opts: z.object({ deep: z.boolean() }) })
    expect(JSON.stringify(to_json_schema(plain))).toBe(JSON.stringify(z.toJSONSchema(plain)))
  })

  it('keeps $schema by default, because providers today receive it', () => {
    expect(to_json_schema(user_schema)['$schema']).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    )
  })

  it('strips $schema and $id when asked, leaving the constraints intact', () => {
    const json = to_json_schema(user_schema, { strip_meta: true })
    expect(json).not.toHaveProperty('$schema')
    expect(json).not.toHaveProperty('$id')
    expect(json['type']).toBe('object')
    expect(json['properties']).toMatchObject({ name: { type: 'string' } })
  })

  it('strips a vendor-supplied $id too, not just $schema', () => {
    const with_id: ToolSchema = {
      '~standard': {
        version: 1,
        vendor: 'id-vendor',
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => ({ $schema: 'urn:dialect', $id: 'urn:in', type: 'object' }),
          output: () => ({ $schema: 'urn:dialect', $id: 'urn:out', type: 'object' }),
        },
      },
    }
    expect(to_json_schema(with_id, { strip_meta: true })).toEqual({ type: 'object' })
  })

  it('reads the input direction, not the output one', () => {
    const both: ToolSchema = {
      '~standard': {
        version: 1,
        vendor: 'two-faced-vendor',
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => ({ type: 'object', title: 'in' }),
          output: () => ({ type: 'object', title: 'out' }),
        },
      },
    }
    expect(to_json_schema(both)['title']).toBe('in')
  })

  it('targets draft-2020-12 unless told otherwise', () => {
    const targets: string[] = []
    const recording: ToolSchema = {
      '~standard': {
        version: 1,
        vendor: 'recording-vendor',
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: (options) => {
            targets.push(options.target)
            return {}
          },
          output: () => ({}),
        },
      },
    }
    to_json_schema(recording)
    to_json_schema(recording, { target: 'draft-07' })
    expect(targets).toEqual(['draft-2020-12', 'draft-07'])
  })

  it('leaves a defaulted field out of required, and still forbids invented keys', () => {
    // The whole point of the composed emission: `age` has a default, so the
    // model may omit it, but it still may not invent a fourth key.
    const json = to_json_schema(user_schema)
    expect(json['required']).toEqual(['name'])
    expect(json['additionalProperties']).toBe(false)
  })

  it('applies both halves at depth, not just to the root', () => {
    const nested = z.object({ outer: z.object({ inner: z.string().default('x') }) })
    expect(to_json_schema(nested)['properties']).toMatchObject({
      outer: { additionalProperties: false },
    })
    const outer = (to_json_schema(nested)['properties'] as Record<string, Record<string, unknown>>)[
      'outer'
    ]
    expect(outer).not.toHaveProperty('required')
  })

  it('closes objects inside arrays and unions too', () => {
    const shaped = z.object({
      items: z.array(z.object({ q: z.string() })),
      either: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
    })
    expect(JSON.stringify(to_json_schema(shaped))).toBe(JSON.stringify(z.toJSONSchema(shaped)))
  })

  it('leaves a deliberately open object open', () => {
    // `looseObject` publishes `additionalProperties: {}`; overwriting that with
    // `false` would invert what the schema author asked for.
    const json = to_json_schema(z.looseObject({ a: z.string() }))
    expect(json['additionalProperties']).toEqual({})
  })

  it('leaves a freeform object freeform', () => {
    // A bare `{ type: 'object' }` with no `properties` is how an MCP server
    // advertises "any payload". Closing it would forbid every key.
    const freeform: ToolSchema = {
      '~standard': {
        version: 1,
        vendor: 'freeform-vendor',
        validate: (value: unknown) => ({ value }),
        jsonSchema: { input: () => ({ type: 'object' }), output: () => ({ type: 'object' }) },
      },
    }
    expect(to_json_schema(freeform)).toEqual({ type: 'object' })
  })

  it('emits a schema carrying a transform, which the output direction cannot', () => {
    const transformed = z.object({ n: z.string().transform((s) => s.length) })
    expect(() => z.toJSONSchema(transformed)).toThrow()
    expect(to_json_schema(transformed)['properties']).toMatchObject({ n: { type: 'string' } })
  })

  it('reaches an object through every keyword that can hold a schema', () => {
    // zod reaches only a few of these, but the emitter takes whatever JSON
    // Schema a vendor produces, and a keyword missing from the walk means a
    // nested object silently ships unclosed.
    const open = { type: 'object', properties: {} }
    const json = to_json_schema(
      fixed_vendor({
        type: 'object',
        properties: { a: { ...open } },
        patternProperties: { '^x': { ...open } },
        $defs: { d: { ...open } },
        definitions: { e: { ...open } },
        items: { ...open },
        additionalItems: { ...open },
        additionalProperties: { ...open },
        propertyNames: { ...open },
        not: { ...open },
        anyOf: [{ ...open }],
        allOf: [{ ...open }],
        oneOf: [{ ...open }],
        prefixItems: [{ ...open }],
      }),
    )

    const shut = { type: 'object', properties: {}, additionalProperties: false }
    expect(json).toEqual({
      type: 'object',
      properties: { a: shut },
      patternProperties: { '^x': shut },
      $defs: { d: shut },
      definitions: { e: shut },
      items: shut,
      additionalItems: shut,
      additionalProperties: shut,
      propertyNames: shut,
      not: shut,
      anyOf: [shut],
      allOf: [shut],
      oneOf: [shut],
      prefixItems: [shut],
    })
  })

  it('closes an object declaring a union of types that includes object', () => {
    const json = to_json_schema(
      fixed_vendor({ type: ['object', 'null'], properties: { a: { type: 'string' } } }),
    )
    expect(json['additionalProperties']).toBe(false)
  })

  it('leaves a node that lists properties without declaring itself an object', () => {
    // Closing keys on something that never said it was an object asserts more
    // than the vendor did, which is the line this whole pass stays behind.
    expect(to_json_schema(fixed_vendor({ properties: { a: { type: 'string' } } }))).not.toHaveProperty(
      'additionalProperties',
    )
  })

  it('survives a malformed type rather than throwing mid-emission', () => {
    // An MCP server's advertisement is arbitrary remote input; emission has to
    // degrade rather than crash tool discovery on a nonsense `type`.
    expect(to_json_schema(fixed_vendor({ type: 7, properties: {} }))).toEqual({
      type: 7,
      properties: {},
    })
  })

  it('leaves a null where a schema should be, instead of reading it as an object', () => {
    const json = to_json_schema(fixed_vendor({ type: 'object', properties: { a: null } }))
    expect((json['properties'] as Record<string, unknown>)['a']).toBeNull()
  })

  it('leaves a boolean schema and a scalar keyword alone', () => {
    const json = to_json_schema(
      fixed_vendor({ type: 'object', properties: { a: true }, additionalItems: false, title: 'x' }),
    )
    expect(json['properties']).toEqual({ a: true })
    expect(json['additionalItems']).toBe(false)
    expect(json['title']).toBe('x')
  })

  it('does not mutate what the vendor handed back', () => {
    // The spec does not promise a fresh object per call, so a cached one must
    // survive emission unchanged.
    const cached: Record<string, unknown> = {
      type: 'object',
      properties: { a: { type: 'string' } },
    }
    const caching: ToolSchema = {
      '~standard': {
        version: 1,
        vendor: 'caching-vendor',
        validate: (value: unknown) => ({ value }),
        jsonSchema: { input: () => cached, output: () => cached },
      },
    }
    expect(to_json_schema(caching)['additionalProperties']).toBe(false)
    expect(cached).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
  })

  it('throws naming the vendor when it cannot emit JSON Schema', () => {
    expect(() => to_json_schema(validate_only_vendor)).toThrow(schema_not_convertible_error)
    try {
      to_json_schema(validate_only_vendor)
      expect.unreachable('to_json_schema should have thrown')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(schema_not_convertible_error)
      const failure = err as schema_not_convertible_error
      expect(failure.vendor).toBe('validate-only-vendor')
      expect(failure.message).toContain('validate-only-vendor')
      expect(failure.name).toBe('schema_not_convertible_error')
    }
  })
})
