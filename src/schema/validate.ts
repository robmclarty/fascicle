/**
 * Validation against any Standard Schema implementation, and the one-line
 * rendering of its failures that repair prompts and error messages use.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { AnySchema, SchemaIssue, ValidateOutcome } from './types.js'

/**
 * Validate `value` against `schema`, returning the typed value or the issues.
 *
 * Always async, even for a validator that answers synchronously: the spec
 * permits `validate` to return either a result or a promise of one, and
 * fascicle cannot know which a given vendor does. Awaiting a non-promise is
 * cheap; guessing wrong is a silent bug.
 */
export async function validate_schema<t>(
  schema: AnySchema<t>,
  value: unknown,
): Promise<ValidateOutcome<t>> {
  const result = await schema['~standard'].validate(value)
  if (result.issues) return { ok: false, issues: result.issues.map(normalize_issue) }
  return { ok: true, value: result.value }
}

/**
 * Flatten one vendor issue into fascicle's shape.
 *
 * The spec allows a path segment to be a bare key or a `{ key }` wrapper, and
 * allows the path to be absent entirely. Normalizing here means no consumer has
 * to know which vendor produced the issue.
 */
function normalize_issue(issue: StandardSchemaV1.Issue): SchemaIssue {
  if (issue.path === undefined) return { message: issue.message }
  const path = issue.path.map((segment) =>
    typeof segment === 'object' ? segment.key : segment,
  )
  return { message: issue.message, path }
}

/**
 * Render issues as the single line that goes into an error message or a repair
 * prompt fed back to the model.
 *
 * Paths are dotted (`address.city`, `items.0.name`) rather than bracketed for
 * indices: the model reads it as a hint about which field to fix, and one
 * consistent separator is easier to follow than two.
 */
export function format_schema_issues(issues: ReadonlyArray<SchemaIssue>): string {
  if (issues.length === 0) return 'unknown schema issue'
  return issues.map(format_issue).join('; ')
}

/**
 * Render one issue as `path: message`, or just the message when the vendor
 * reported no path (a failure about the value as a whole).
 */
function format_issue(issue: SchemaIssue): string {
  const path = issue.path
  if (path === undefined || path.length === 0) return issue.message
  return `${path.map((segment) => String(segment)).join('.')}: ${issue.message}`
}
