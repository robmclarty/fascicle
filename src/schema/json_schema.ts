/**
 * JSON Schema emission for schemas that reach a model.
 *
 * Standard JSON Schema exposes two directions, `input` and `output`. fascicle
 * emits the output direction because that is what `z.toJSONSchema` produced
 * before this zone existed, and provider payloads must stay byte-identical
 * across the migration. Which direction is semantically right for a tool
 * definition (input un-requires defaulted fields, which is arguably what a
 * model should be told) is a deliberate follow-up, not a change to smuggle in
 * behind a refactor.
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
  if (typeof props.jsonSchema?.output !== 'function') {
    throw new schema_not_convertible_error(props.vendor)
  }
  const json = props.jsonSchema.output({ target: options.target ?? DEFAULT_TARGET })
  return options.strip_meta === true ? strip_meta_keys(json) : json
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
