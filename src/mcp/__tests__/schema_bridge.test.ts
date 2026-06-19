import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { json_schema_to_zod } from '../schema_bridge.js'

describe('json_schema_to_zod', () => {
  it('converts primitive types', () => {
    expect(json_schema_to_zod({ type: 'string' }).safeParse('x').success).toBe(true)
    expect(json_schema_to_zod({ type: 'string' }).safeParse(1).success).toBe(false)
    expect(json_schema_to_zod({ type: 'number' }).safeParse(1.5).success).toBe(true)
    expect(json_schema_to_zod({ type: 'integer' }).safeParse(2).success).toBe(true)
    expect(json_schema_to_zod({ type: 'integer' }).safeParse(2.5).success).toBe(false)
    expect(json_schema_to_zod({ type: 'boolean' }).safeParse(true).success).toBe(true)
    expect(json_schema_to_zod({ type: 'null' }).safeParse(null).success).toBe(true)
  })

  it('honors required vs optional object properties and keeps extra keys', () => {
    const schema = json_schema_to_zod({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    })
    expect(schema.safeParse({ a: 'x' }).success).toBe(true)
    expect(schema.safeParse({ b: 1 }).success).toBe(false)
    // Loose objects pass unmodeled args through to the server, which re-validates.
    const parsed = schema.safeParse({ a: 'x', extra: true })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toEqual({ a: 'x', extra: true })
  })

  it('converts nested objects and arrays', () => {
    const schema = json_schema_to_zod({
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      },
      required: ['items', 'nested'],
    })
    expect(schema.safeParse({ items: ['a', 'b'], nested: { n: 1 } }).success).toBe(true)
    expect(schema.safeParse({ items: [1], nested: { n: 1 } }).success).toBe(false)
    expect(schema.safeParse({ items: [], nested: {} }).success).toBe(false)
  })

  it('converts enum, const, and unions', () => {
    expect(json_schema_to_zod({ enum: ['a', 'b'] }).safeParse('a').success).toBe(true)
    expect(json_schema_to_zod({ enum: ['a', 'b'] }).safeParse('c').success).toBe(false)
    expect(json_schema_to_zod({ const: 42 }).safeParse(42).success).toBe(true)
    expect(json_schema_to_zod({ const: 42 }).safeParse(43).success).toBe(false)
    const u = json_schema_to_zod({ anyOf: [{ type: 'string' }, { type: 'number' }] })
    expect(u.safeParse('x').success).toBe(true)
    expect(u.safeParse(1).success).toBe(true)
    expect(u.safeParse(true).success).toBe(false)
  })

  it('intersects allOf members', () => {
    const schema = json_schema_to_zod({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    })
    expect(schema.safeParse({ a: 'x', b: 1 }).success).toBe(true)
    expect(schema.safeParse({ a: 'x' }).success).toBe(false)
  })

  it('treats a mixed-type enum as a union of literals', () => {
    const schema = json_schema_to_zod({ enum: ['on', 1, true] })
    expect(schema.safeParse('on').success).toBe(true)
    expect(schema.safeParse(1).success).toBe(true)
    expect(schema.safeParse(true).success).toBe(true)
    expect(schema.safeParse('off').success).toBe(false)
  })

  it('unwraps a single-member union', () => {
    const schema = json_schema_to_zod({ anyOf: [{ type: 'boolean' }] })
    expect(schema.safeParse(true).success).toBe(true)
    expect(schema.safeParse('x').success).toBe(false)
  })

  it('supports boolean and null const', () => {
    expect(json_schema_to_zod({ const: true }).safeParse(true).success).toBe(true)
    expect(json_schema_to_zod({ const: true }).safeParse(false).success).toBe(false)
    expect(json_schema_to_zod({ const: null }).safeParse(null).success).toBe(true)
  })

  it('accepts an array of objects', () => {
    const schema = json_schema_to_zod({
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    })
    expect(schema.safeParse([{ id: 1 }, { id: 2 }]).success).toBe(true)
    expect(schema.safeParse([{ id: 'x' }]).success).toBe(false)
  })

  it('handles the array type form for nullable', () => {
    const schema = json_schema_to_zod({ type: ['string', 'null'] })
    expect(schema.safeParse('x').success).toBe(true)
    expect(schema.safeParse(null).success).toBe(true)
    expect(schema.safeParse(1).success).toBe(false)
  })

  it('degrades to a permissive type for unrecognized constructs', () => {
    // A $ref/vendor construct it cannot model must never reject a valid arg.
    const schema = json_schema_to_zod({ $ref: '#/definitions/Thing' })
    expect(schema.safeParse({ anything: 1 }).success).toBe(true)
    expect(schema.safeParse('string').success).toBe(true)
    expect(schema.safeParse(null).success).toBe(true)
  })

  it('never throws on malformed input', () => {
    expect(() => json_schema_to_zod(null)).not.toThrow()
    expect(() => json_schema_to_zod(42)).not.toThrow()
    expect(json_schema_to_zod(null).safeParse({ x: 1 }).success).toBe(true)
  })

  it('returns a permissive schema when conversion throws partway through', () => {
    // A schema whose property access throws must be caught, not propagated:
    // tool discovery cannot crash on a hostile remote schema.
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom')
        },
        has() {
          return false
        },
      },
    )
    expect(json_schema_to_zod(hostile).safeParse({ anything: 1 }).success).toBe(true)
  })

  it('does not apply a non-string description', () => {
    // Only a string `description` is forwarded; a non-string one is dropped so
    // it cannot leak into the emitted JSON Schema.
    const js = z.toJSONSchema(json_schema_to_zod({ type: 'string', description: 123 }))
    expect('description' in js).toBe(false)
  })

  it('degrades an unrecognized type keyword to a permissive schema', () => {
    const schema = json_schema_to_zod({ type: 'bogus-type' })
    expect(schema.safeParse('x').success).toBe(true)
    expect(schema.safeParse({ any: 1 }).success).toBe(true)
  })

  it('treats oneOf as a union', () => {
    const schema = json_schema_to_zod({ oneOf: [{ type: 'string' }, { type: 'number' }] })
    expect(schema.safeParse('x').success).toBe(true)
    expect(schema.safeParse(1).success).toBe(true)
    expect(schema.safeParse(true).success).toBe(false)
  })

  it('treats a typeless schema with properties as an object', () => {
    const schema = json_schema_to_zod({
      properties: { a: { type: 'string' } },
      required: ['a'],
    })
    expect(schema.safeParse({ a: 'x' }).success).toBe(true)
    expect(schema.safeParse({ a: 1 }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
  })

  it('keeps an object permissive but still typed when no properties are required', () => {
    // Without `required`, every property is optional, but the result must still
    // emit `{type:"object"}` rather than degrading to the empty schema.
    const js = z.toJSONSchema(json_schema_to_zod({ type: 'object', properties: { a: { type: 'string' } } }))
    expect(js).toMatchObject({ type: 'object' })
  })

  it('accepts anything for an empty enum', () => {
    expect(json_schema_to_zod({ enum: [] }).safeParse('x').success).toBe(true)
  })

  it('emits a string enum as an enum, not a union of literals', () => {
    const js = z.toJSONSchema(json_schema_to_zod({ enum: ['a', 'b'] })) as Record<string, unknown>
    expect(js['type']).toBe('string')
    expect(js['enum']).toEqual(['a', 'b'])
  })

  it('accepts anything for an empty anyOf', () => {
    expect(json_schema_to_zod({ anyOf: [] }).safeParse('x').success).toBe(true)
  })

  it('matches only null for a null const and rejects other values', () => {
    const schema = json_schema_to_zod({ const: null })
    expect(schema.safeParse(null).success).toBe(true)
    expect(schema.safeParse('x').success).toBe(false)
  })

  it('stays permissive for a const whose value is not a primitive', () => {
    // Object/array consts are not expressible as z.literal, so they degrade to
    // an accept-anything schema rather than a null- or literal-shaped one.
    expect(json_schema_to_zod({ const: { a: 1 } }).safeParse('x').success).toBe(true)
  })

  it('accepts a permissive array for tuple-style items', () => {
    const schema = json_schema_to_zod({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] })
    expect(schema.safeParse(['a', 1]).success).toBe(true)
    expect(schema.safeParse([1, 'a', true]).success).toBe(true)
  })

  it('preserves provider fidelity: a freeform object emits {type:object}, not {}', () => {
    // The whole point: z.unknown() would emit {} and starve the provider of the
    // parameter shape, so a typeless object must round-trip as an object.
    const freeform = z.toJSONSchema(json_schema_to_zod({ type: 'object' }))
    expect(freeform).toMatchObject({ type: 'object' })

    const shaped = z.toJSONSchema(
      json_schema_to_zod({
        type: 'object',
        properties: { city: { type: 'string', description: 'A city name' } },
        required: ['city'],
      }),
    )
    expect(shaped).toMatchObject({
      type: 'object',
      properties: { city: { type: 'string', description: 'A city name' } },
      required: ['city'],
    })
  })
})
