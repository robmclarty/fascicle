/**
 * Public surface for schema.
 *
 * The vendor-neutral schema seam: the types Fascicle accepts from users, the
 * validator it runs them through, and the JSON Schema it hands to providers.
 * Internal to the package: `#schema` has no published subpath, because the
 * types travel out through the surfaces that use them rather than on their own.
 */

export { schema_not_convertible_error } from './errors.js'
export { to_json_schema } from './json_schema.js'
export { format_schema_issues, validate_schema } from './validate.js'
export type {
  AnySchema,
  JsonSchemaOptions,
  JsonSchemaTarget,
  SchemaIssue,
  ToolSchema,
  ValidateOutcome,
} from './types.js'
