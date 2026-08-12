/**
 * The schema vocabulary fascicle speaks at its public surface.
 *
 * fascicle validates values and emits JSON Schema, but it has no business
 * dictating which validation library a user brings. Standard Schema is the
 * vendor-neutral interface every major validator now implements, and
 * `@standard-schema/spec` is pure types: its ESM entry is a zero-byte file, so
 * depending on it adds no runtime weight and no runtime dependency.
 *
 * The zone sits at the bottom of the dependency DAG. Core, engine, mcp, and
 * stdio all reach into it, so it imports nothing but the spec's types.
 */

import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec'

/**
 * Any Standard Schema implementation, used where fascicle only ever validates.
 *
 * `t` is the validated output type, which is what callers care about; the input
 * side stays `unknown` because fascicle validates values arriving from a model,
 * a resume payload, or stdin, none of which are typed at the boundary.
 */
export type AnySchema<t = unknown> = StandardSchemaV1<unknown, t>

/**
 * A Standard Schema that can also emit JSON Schema.
 *
 * Required wherever a schema must reach a model as JSON Schema: tool
 * definitions and structured output. This is a deliberate narrowing of
 * `AnySchema` rather than an oversight, because a schema that cannot be
 * expressed as JSON Schema cannot be sent to a provider at all.
 */
export type ToolSchema<t = unknown> = StandardSchemaV1<unknown, t> & StandardJSONSchemaV1

/**
 * The JSON Schema dialect `to_json_schema` emits.
 *
 * Re-exported so callers can name a dialect without importing the spec
 * package, which is a devDependency here and absent from a consumer's install.
 */
export type JsonSchemaTarget = StandardJSONSchemaV1.Target

/**
 * One validation failure, flattened out of whichever shape the vendor used.
 *
 * The spec permits a path segment to be either a bare key or an object
 * wrapping one; `validate_schema` normalizes both to the bare key so every
 * consumer downstream reads one shape.
 */
export type SchemaIssue = {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey>
}

/**
 * The result of validating a value: the typed value, or the issues explaining
 * why it was rejected.
 *
 * A tagged union rather than a throw, because every fascicle call site treats a
 * validation failure as data (a repair prompt, a tool-result error message)
 * rather than an exception.
 */
export type ValidateOutcome<t> =
  | { ok: true; value: t }
  | { ok: false; issues: ReadonlyArray<SchemaIssue> }

/**
 * How to emit JSON Schema for a `ToolSchema`.
 *
 * `strip_meta` drops the top-level `$schema` and `$id` keys. It is off by
 * default because the providers fascicle speaks to today receive those keys and
 * tolerate them; only `claude --json-schema` rejects them, so only that adapter
 * asks.
 */
export type JsonSchemaOptions = {
  readonly target?: JsonSchemaTarget
  readonly strip_meta?: boolean
}
