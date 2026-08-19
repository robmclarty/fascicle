/**
 * JSON Schema emission for schemas that reach a model.
 *
 * Standard JSON Schema exposes two directions, `input` and `output`. A tool
 * definition describes what the model should *produce*, so Fascicle emits the
 * input direction: a field with a default is one the model may omit, and
 * saying otherwise asks it to supply a value the schema already supplies.
 *
 * The input direction alone is too loose, though. A vendor describes what it
 * will accept, and accepting unknown keys is the common default (zod's
 * `z.object` strips them, ArkType ignores them), so nothing in the emitted
 * schema stops a model inventing one. `close_objects` supplies that guard,
 * which is also what the strict and constrained-decode modes require. The AI
 * SDK composes the same two halves for every `kind: 'ai_sdk'` provider, so
 * this is what the majority of Fascicle's transports already send.
 */

import { schema_not_convertible_error } from './errors.js'
import type { JsonSchemaOptions, ToolSchema } from './types.js'

const DEFAULT_TARGET = 'draft-2020-12'

/**
 * Emit JSON Schema for `schema`, targeting draft-2020-12 unless told otherwise.
 *
 * `target` is passed explicitly on every call because the spec makes it a
 * required argument of the converter, even where a vendor tolerates its
 * omission. A vendor that implements Standard Schema but not Standard JSON
 * Schema raises `schema_not_convertible_error` naming itself, so the message
 * says which library to swap rather than just that something failed.
 */
export function to_json_schema(
  schema: ToolSchema,
  options: JsonSchemaOptions = {},
): Record<string, unknown> {
  const props = schema['~standard']
  if (typeof props.jsonSchema?.input !== 'function') {
    throw new schema_not_convertible_error(props.vendor)
  }
  const json = close_objects(props.jsonSchema.input({ target: options.target ?? DEFAULT_TARGET }))
  return options.strip_meta === true ? strip_meta_keys(json) : json
}

/** Keys whose value is a bag of nested schemas, one per name. */
const SCHEMA_BAGS = ['properties', 'patternProperties', '$defs', 'definitions']

/** Keys whose value is a nested schema, or a list of them. */
const SCHEMA_SLOTS = [
  'items',
  'additionalItems',
  'additionalProperties',
  'propertyNames',
  'not',
  'anyOf',
  'allOf',
  'oneOf',
  'prefixItems',
]

/**
 * Add `additionalProperties: false` to every object node that does not already
 * constrain it, so the model is told which keys exist rather than left to
 * invent them.
 *
 * Two restraints keep this from asserting more than the vendor did. An
 * existing `additionalProperties` is never overwritten, so a deliberately open
 * schema (zod's `looseObject`, a `record`'s value schema, a server that
 * published `true`) stays open. And a node is only closed if it declares
 * `properties`: a bare `{ type: 'object' }` is how a freeform payload is
 * described, most visibly by an MCP server, and closing it would forbid every
 * key rather than constrain the listed ones. Every zod object emits
 * `properties`, `z.object({})` included, so the guard costs nothing there.
 *
 * The tree is rebuilt rather than mutated. The spec does not promise a fresh
 * object per call, and a vendor handing back a cached one would be corrupted
 * by an in-place stamp. Recursion terminates on any schema: a self-referential
 * schema emits `$ref`, which is a string, not a nested node.
 */
function close_objects(node: Record<string, unknown>): Record<string, unknown> {
  const closed = close_nested(node)
  return needs_closing(closed) ? { ...closed, additionalProperties: false } : closed
}

/** Rebuild `node` with every schema it holds closed, leaving its own keys alone. */
function close_nested(node: Record<string, unknown>): Record<string, unknown> {
  const closed: Record<string, unknown> = { ...node }
  for (const key of SCHEMA_BAGS) {
    const bag = closed[key]
    if (is_node(bag)) closed[key] = close_bag(bag)
  }
  for (const key of SCHEMA_SLOTS) {
    if (key in closed) closed[key] = close_value(closed[key])
  }
  return closed
}

/** Rebuild a name-to-schema bag with each of its schemas closed. */
function close_bag(bag: Record<string, unknown>): Record<string, unknown> {
  const closed: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(bag)) closed[name] = close_value(value)
  return closed
}

/** Recurse into a schema or a list of them, leaving anything else alone. */
function close_value(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(close_value)
  return is_node(value) ? close_objects(value) : value
}

/** True for an object node listing its keys but not saying whether more are allowed. */
function needs_closing(node: Record<string, unknown>): boolean {
  if ('additionalProperties' in node || !('properties' in node)) return false
  const type = node['type']
  return type === 'object' || (Array.isArray(type) && type.includes('object'))
}

/** A JSON Schema node, as opposed to a boolean schema, a list, or a scalar. */
function is_node(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Drop the top-level `$schema` and `$id` keys.
 *
 * `claude --json-schema` rejects both, and the field constraints alone drive
 * constrained decode, so the CLI adapter asks for a stripped emission.
 */
function strip_meta_keys(json: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, $id: _id, ...rest } = json
  return rest
}
