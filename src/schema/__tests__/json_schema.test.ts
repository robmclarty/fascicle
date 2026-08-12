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

describe('to_json_schema', () => {
  it('emits bytes identical to the zod call it replaces', () => {
    expect(JSON.stringify(to_json_schema(user_schema))).toBe(
      JSON.stringify(z.toJSONSchema(user_schema)),
    )
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
          input: () => ({ $id: 'urn:in', type: 'object' }),
          output: () => ({ $schema: 'urn:dialect', $id: 'urn:out', type: 'object' }),
        },
      },
    }
    expect(to_json_schema(with_id, { strip_meta: true })).toEqual({ type: 'object' })
  })

  it('targets draft-2020-12 unless told otherwise', () => {
    const targets: string[] = []
    const recording: ToolSchema = {
      '~standard': {
        version: 1,
        vendor: 'recording-vendor',
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => ({}),
          output: (options) => {
            targets.push(options.target)
            return {}
          },
        },
      },
    }
    to_json_schema(recording)
    to_json_schema(recording, { target: 'draft-07' })
    expect(targets).toEqual(['draft-2020-12', 'draft-07'])
  })

  it('emits the output direction, which is what keeps provider payloads stable', () => {
    const json = to_json_schema(user_schema)
    expect(json['required']).toEqual(['name', 'age'])
    expect(json['additionalProperties']).toBe(false)
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
