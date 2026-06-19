/**
 * JSON Schema to Zod conversion for inbound MCP tools.
 *
 * An MCP tool advertises its input as JSON Schema, but a fascicle `Tool` carries
 * a Zod `input_schema` that the tool loop `safeParse`s before `execute` and the
 * engine serializes back to JSON Schema for the provider. So the converted Zod
 * must do two things at once: stay permissive enough never to reject an arg the
 * remote server would accept, and round-trip through `z.toJSONSchema` to a shape
 * the provider can fill.
 *
 * Two deliberate choices serve those goals. Objects are `looseObject` so extra
 * keys survive to the server (which re-validates and is the real authority), and
 * a freeform object maps to `z.looseObject({})` (emits `{type:"object"}`) rather
 * than `z.unknown()` (emits `{}`), preserving the "takes an object" signal. Value
 * constraints (min/max, length, pattern, format) are intentionally not modeled:
 * they add rejection risk for marginal provider benefit, and the server enforces
 * them anyway. Structure, types, enums, const, unions, and descriptions are
 * preserved; anything unrecognized degrades to `z.unknown()`.
 */

import { z } from 'zod'
import { as_record, is_record } from './internal.js'

export function json_schema_to_zod(schema: unknown): z.ZodType {
  try {
    return convert(schema)
  } catch {
    // An arbitrary remote schema must never crash tool discovery.
    return z.unknown()
  }
}

function convert(node: unknown): z.ZodType {
  const schema = as_record(node)
  if (schema === undefined) return z.unknown()

  const described = (inner: z.ZodType): z.ZodType => {
    const description = schema['description']
    return typeof description === 'string' ? inner.describe(description) : inner
  }

  if ('const' in schema) return described(literal_of(schema['const']))
  if (Array.isArray(schema['enum'])) return described(enum_of(schema['enum']))
  if (Array.isArray(schema['anyOf'])) return described(union_of(schema['anyOf']))
  if (Array.isArray(schema['oneOf'])) return described(union_of(schema['oneOf']))
  if (Array.isArray(schema['allOf'])) return described(intersection_of(schema['allOf']))

  const type = schema['type']
  if (Array.isArray(type)) {
    return described(union_of_types(type, schema))
  }
  if (typeof type === 'string') {
    return described(for_type(type, schema))
  }
  // No explicit type: an object with declared properties is still an object;
  // otherwise nothing structural is known, so stay permissive.
  if (is_record(schema['properties'])) return described(build_object(schema))
  return described(z.unknown())
}

function for_type(type: string, schema: Record<string, unknown>): z.ZodType {
  switch (type) {
    case 'object':
      return build_object(schema)
    case 'array':
      return build_array(schema)
    case 'string':
      return z.string()
    case 'number':
      return z.number()
    case 'integer':
      return z.number().int()
    case 'boolean':
      return z.boolean()
    case 'null':
      return z.null()
    default:
      return z.unknown()
  }
}

function build_object(schema: Record<string, unknown>): z.ZodType {
  const properties = as_record(schema['properties']) ?? {}
  const required = new Set(string_array(schema['required']))
  const shape: Record<string, z.ZodType> = {}
  for (const [key, prop] of Object.entries(properties)) {
    const child = convert(prop)
    shape[key] = required.has(key) ? child : child.optional()
  }
  return z.looseObject(shape)
}

function build_array(schema: Record<string, unknown>): z.ZodType {
  const items = schema['items']
  if (Array.isArray(items)) {
    // Tuple positional schemas are rare in MCP tools and the server validates
    // them anyway, so accept a permissive array rather than a narrowing cast.
    return z.array(z.unknown())
  }
  return z.array(items !== undefined ? convert(items) : z.unknown())
}

function enum_of(values: unknown[]): z.ZodType {
  if (values.length === 0) return z.unknown()
  if (values.every((v): v is string => typeof v === 'string')) {
    return z.enum(values)
  }
  return combine_union(values.map(literal_of))
}

function union_of(nodes: unknown[]): z.ZodType {
  return combine_union(nodes.map(convert))
}

function union_of_types(types: unknown[], schema: Record<string, unknown>): z.ZodType {
  return combine_union(types.map((t) => for_type(String(t), schema)))
}

function intersection_of(nodes: unknown[]): z.ZodType {
  const parts = nodes.map(convert)
  if (parts.length === 0) return z.unknown()
  return parts.reduce((acc, part) => z.intersection(acc, part))
}

function combine_union(variants: z.ZodType[]): z.ZodType {
  const [first, second, ...rest] = variants
  if (first === undefined) return z.unknown()
  if (second === undefined) return first
  return z.union([first, second, ...rest])
}

function literal_of(value: unknown): z.ZodType {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return z.literal(value)
  }
  if (value === null) return z.null()
  // Object and array literals are not expressible as z.literal; accept anything.
  return z.unknown()
}

function string_array(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}
