/**
 * A Standard Schema over an inbound MCP tool's advertised JSON Schema.
 *
 * An MCP tool advertises its input as JSON Schema, and a fascicle `Tool` carries
 * a `ToolSchema` that the tool loop validates before `execute` and the engine
 * emits back to the provider as JSON Schema. Those are two faces of one object,
 * so this bridge builds both directly over the schema the server sent: emission
 * hands the advertised schema back unchanged, and validation walks it.
 *
 * The old bridge converted the advertised schema into Zod so the provider path
 * could convert it back, a round trip that was lossy by construction. Verbatim
 * emission is strictly higher fidelity: whatever the server declared is what the
 * model is told, including the constraints (`minLength`, `format`, `pattern`)
 * the Zod conversion dropped.
 *
 * Validation stays deliberately loose, unchanged from the Zod bridge's reach:
 * structure, types, enums, const, unions, and required keys are checked, value
 * constraints are not, extra keys pass through to the server, and anything
 * unrecognized accepts. The remote server re-validates its own arguments and is
 * the authority on them, so this check is a guard against an obviously wrong
 * call, not the contract.
 */

import type { SchemaIssue, ToolSchema } from '#schema'
import { as_record, is_record } from './internal.js'

/**
 * Builds a `ToolSchema` over an MCP server's advertised JSON Schema.
 *
 * The advertised schema is snapshotted once, deeply, and both faces of the
 * returned object read that snapshot. A malformed or hostile schema degrades to
 * the empty schema during the snapshot rather than propagating an error, since
 * an arbitrary remote server's advertisement must never crash tool discovery,
 * and it leaves both faces describing the same thing: accept anything, emit
 * nothing.
 */
export function json_schema_to_standard(schema: unknown): ToolSchema {
  const advertised = snapshot(schema)
  return {
    '~standard': {
      version: 1,
      vendor: 'fascicle-mcp',
      validate: (value: unknown) => {
        const issues = check(advertised, value, [])
        return issues.length === 0 ? { value } : { issues }
      },
      jsonSchema: {
        // `target` is ignored in both directions: fascicle applies no transform,
        // so there is no re-targeting to do, and the dialect on the wire is
        // whichever one the server chose to advertise. Each call returns a fresh
        // copy because consumers mutate what they are handed (the AI SDK stamps
        // `additionalProperties` onto it in place), and a shared snapshot would
        // stop being verbatim after the first turn.
        input: () => clone_schema(advertised),
        output: () => clone_schema(advertised),
      },
    },
  }
}

/**
 * Deep-copies the advertised schema, or yields the empty schema when it is not
 * an object or cannot be read.
 *
 * Copying here means every later read walks plain data: a schema with throwing
 * accessors or a cycle fails once, at discovery, instead of on some later call.
 */
function snapshot(schema: unknown): Record<string, unknown> {
  try {
    const record = as_record(schema)
    return record === undefined ? {} : clone_schema(record)
  } catch {
    return {}
  }
}

/**
 * Deep-copies one JSON Schema node.
 */
function clone_schema(schema: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) copy[key] = clone_value(value)
  return copy
}

/**
 * Deep-copies a value inside a schema, recursing through arrays and objects and
 * returning every other value as is.
 */
function clone_value(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone_value)
  return is_record(value) ? clone_schema(value) : value
}

/**
 * Checks one value against one JSON Schema node, returning the issues it
 * violated, or an empty array when it passes.
 *
 * A node that is not an object constrains nothing and accepts, which is what
 * makes a construct this bridge does not model degrade rather than reject.
 */
function check(node: unknown, value: unknown, path: ReadonlyArray<PropertyKey>): SchemaIssue[] {
  const schema = as_record(node)
  if (schema === undefined) return []
  return check_keywords(schema, value, path) ?? check_shape(schema, value, path)
}

/**
 * Checks the keywords that stand on their own, returning `undefined` when the
 * node carries none of them.
 *
 * These are checked before `type` because they can appear without one and take
 * precedence when they do: a node with both `enum` and `type` is constrained by
 * the enum, which is the narrower of the two.
 */
function check_keywords(
  schema: Record<string, unknown>,
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
): SchemaIssue[] | undefined {
  if ('const' in schema) return check_const(schema['const'], value, path)
  if (Array.isArray(schema['enum'])) return check_enum(schema['enum'], value, path)
  if (Array.isArray(schema['anyOf'])) return check_any_of(schema['anyOf'], value, path)
  if (Array.isArray(schema['oneOf'])) return check_any_of(schema['oneOf'], value, path)
  if (Array.isArray(schema['allOf'])) return check_all_of(schema['allOf'], value, path)
  return undefined
}

/**
 * Checks the node's declared shape: its `type`, in either the single or the
 * array form.
 *
 * A node with no `type` but declared `properties` is still an object; a node
 * with neither says nothing structural and accepts.
 */
function check_shape(
  schema: Record<string, unknown>,
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
): SchemaIssue[] {
  const type = schema['type']
  if (Array.isArray(type)) return check_type_union(type, schema, value, path)
  if (typeof type === 'string') return check_type(type, schema, value, path)
  if (is_record(schema['properties'])) return check_object(schema, value, path)
  return []
}

/**
 * Checks a `const`, which pins the value to one JSON literal.
 *
 * An object or array `const` accepts anything: matching it would mean a deep
 * comparison the server performs itself, and rejecting a valid argument is the
 * one failure mode this bridge must not have.
 */
function check_const(
  expected: unknown,
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
): SchemaIssue[] {
  if (expected === null) return value === null ? [] : [issue('expected null', path)]
  if (
    typeof expected === 'string' ||
    typeof expected === 'number' ||
    typeof expected === 'boolean'
  ) {
    return value === expected ? [] : [issue(`expected ${JSON.stringify(expected)}`, path)]
  }
  return []
}

/**
 * Checks an `enum`, which pins the value to one of a list of JSON literals.
 * An empty enum constrains nothing and accepts.
 */
function check_enum(
  values: unknown[],
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
): SchemaIssue[] {
  if (values.length === 0) return []
  if (values.some((candidate) => check_const(candidate, value, path).length === 0)) return []
  return [issue(`expected one of ${values.map((v) => JSON.stringify(v)).join(', ')}`, path)]
}

/**
 * Checks an `anyOf` or `oneOf`, which passes when any branch passes.
 *
 * `oneOf`'s exactly-one semantics are deliberately relaxed to at-least-one: the
 * distinction only ever rejects a value the server would accept.
 *
 * A single-branch union reports that branch's own issues rather than a generic
 * "no variant matched", since with one variant there is no ambiguity about
 * which one failed.
 */
function check_any_of(
  nodes: unknown[],
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
): SchemaIssue[] {
  if (nodes.length === 0) return []
  if (nodes.length === 1) return check(nodes[0], value, path)
  if (nodes.some((node) => check(node, value, path).length === 0)) return []
  return [issue(`expected one of ${nodes.length} variants`, path)]
}

/**
 * Checks an `allOf`, which passes only when every branch passes.
 */
function check_all_of(
  nodes: unknown[],
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
): SchemaIssue[] {
  return nodes.flatMap((node) => check(node, value, path))
}

/**
 * Checks the array form of `type` (`["string", "null"]`), which passes when the
 * value matches any listed type. The other keywords on the node apply to
 * whichever type matched, so each branch sees the whole node.
 */
function check_type_union(
  types: unknown[],
  schema: Record<string, unknown>,
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
): SchemaIssue[] {
  if (types.length === 0) return []
  if (types.length === 1) return check_type(String(types[0]), schema, value, path)
  if (types.some((type) => check_type(String(type), schema, value, path).length === 0)) return []
  return [issue(`expected one of ${types.map(String).join(', ')}`, path)]
}

/**
 * The scalar `type` keywords, as predicates over the value.
 *
 * `number` rejects `NaN` and infinities because neither survives JSON, and
 * `integer` is the same check narrowed to whole values.
 */
const SCALAR_TYPES: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
}

/**
 * Checks one `type` keyword. `object` and `array` recurse into the node's own
 * `properties` and `items`; everything else is a scalar predicate.
 *
 * An unrecognized type accepts, so a vendor extension cannot reject an argument
 * the server would take.
 */
function check_type(
  type: string,
  schema: Record<string, unknown>,
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
): SchemaIssue[] {
  if (type === 'object') return check_object(schema, value, path)
  if (type === 'array') return check_array(schema, value, path)
  const matches = SCALAR_TYPES[type]
  if (matches === undefined) return []
  return matches(value) ? [] : [type_issue(type, value, path)]
}

/**
 * Checks an object against its `properties` and `required`.
 *
 * Keys the schema does not declare are left alone rather than rejected, so an
 * argument this bridge did not anticipate still reaches the server, which
 * re-validates and is the real authority. A `required` name with no entry in
 * `properties` is likewise not enforced: there is nothing to check it against.
 */
function check_object(
  schema: Record<string, unknown>,
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
): SchemaIssue[] {
  if (!is_record(value)) return [type_issue('object', value, path)]
  const properties = as_record(schema['properties']) ?? {}
  const required = new Set(string_array(schema['required']))
  const issues: SchemaIssue[] = []
  for (const [key, property] of Object.entries(properties)) {
    const child = value[key]
    if (child === undefined) {
      if (required.has(key)) issues.push(issue('required', [...path, key]))
      continue
    }
    issues.push(...check(property, child, [...path, key]))
  }
  return issues
}

/**
 * Checks an array against its `items`.
 *
 * A positional-tuple `items` (an array rather than a node) is not a record, so
 * every element accepts. Tuple schemas are rare in MCP tools and the server
 * re-validates them anyway.
 */
function check_array(
  schema: Record<string, unknown>,
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
): SchemaIssue[] {
  if (!Array.isArray(value)) return [type_issue('array', value, path)]
  return value.flatMap((item, index) => check(schema['items'], item, [...path, index]))
}

/**
 * Builds a type-mismatch issue naming what was expected and what arrived.
 */
function type_issue(
  expected: string,
  value: unknown,
  path: ReadonlyArray<PropertyKey>,
): SchemaIssue {
  return issue(`expected ${expected}, received ${describe(value)}`, path)
}

/**
 * Names a value's type the way a JSON Schema reader would, separating `null`
 * and arrays out of `typeof`'s `object`.
 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * Builds one issue, omitting the path entirely at the root so a failure about
 * the value as a whole does not report an empty path.
 */
function issue(message: string, path: ReadonlyArray<PropertyKey>): SchemaIssue {
  return path.length === 0 ? { message } : { message, path: [...path] }
}

/**
 * Filters a value down to the strings it contains, or an empty array when it
 * is not an array at all.
 */
function string_array(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}
