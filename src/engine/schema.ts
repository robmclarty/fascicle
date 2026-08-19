/**
 * Schema parse and repair helpers.
 *
 * The tool-loop / generate orchestrator owns the repair loop itself (counting
 * attempts toward `max_steps`, re-dispatching through the provider). This
 * module exposes only the parse primitive and the canonical repair-prompt
 * shape.
 */

import { format_schema_issues, validate_schema, type AnySchema, type SchemaIssue } from '#schema'
import type { Message } from './types.js'
import { schema_validation_error } from './errors.js'

export type ParseOutcome<t> =
  | { ok: true; value: t }
  | { ok: false; issues: ReadonlyArray<SchemaIssue> }

/**
 * Attempt to parse `text` as JSON and validate it with `schema`. Returns a
 * tagged union; the caller decides whether to escalate to repair, throw, or
 * surface the failure.
 *
 * Even with --json-schema enforcement, models occasionally wrap structured
 * output in markdown fences and surrounding prose. We try a sequence of
 * candidates in increasing leniency: the trimmed text as-is, every fenced
 * block in the text, and the outermost {…} / […] slice. The first candidate
 * that both parses as JSON and matches the schema wins.
 *
 * When every candidate fails, we prefer the schema-validation issues from the
 * FIRST candidate that parsed as JSON: those issues reflect the model's
 * primary output and are what a repair prompt should feed back. Later
 * candidates (for example, the bracket-slice fallback) often produce noisy issues
 * like "expected object, received array" that misdirect the model. Only when
 * NO candidate parses as JSON do we surface the JSON parse error.
 *
 * Async because Standard Schema permits a vendor's `validate` to return a
 * promise; the ripple stops at generate.ts and the claude_cli adapter, both of
 * which already await their surrounding work.
 */
export async function parse_with_schema<t>(
  schema: AnySchema<t>,
  text: string,
): Promise<ParseOutcome<t>> {
  const candidates = json_candidates(text)
  let json_parse_issues: ReadonlyArray<SchemaIssue> = [
    { message: 'No JSON-parseable content found in model output' },
  ]
  let first_schema_issues: ReadonlyArray<SchemaIssue> | undefined
  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch (err: unknown) {
      json_parse_issues = [{ message: err instanceof Error ? err.message : String(err) }]
      continue
    }
    const result = await validate_schema(schema, parsed)
    if (result.ok) return { ok: true, value: result.value }
    first_schema_issues ??= result.issues
  }
  return { ok: false, issues: first_schema_issues ?? json_parse_issues }
}

const FENCE_BLOCK = /```(?:[\w-]*)\s*\n?([\s\S]*?)\n?```/g

/**
 * Generate JSON substrings to try parsing, from strictest to most lenient:
 * the trimmed text as-is, the body of every fenced code block, and the
 * outermost `{...}` and `[...]` slices. Duplicate candidates are dropped.
 */
function json_candidates(text: string): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const push = (s: string): void => {
    const trimmed = s.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) return
    seen.add(trimmed)
    candidates.push(trimmed)
  }
  push(text)
  for (const match of text.matchAll(FENCE_BLOCK)) {
    const body = match[1]
    if (body !== undefined) push(body)
  }
  push(slice_outermost(text, '{', '}'))
  push(slice_outermost(text, '[', ']'))
  return candidates
}

/**
 * Slice `text` from its first `open` character through its last matching
 * `close` character, inclusive. Returns an empty string if `open` is absent
 * or `close` does not appear after it.
 */
function slice_outermost(text: string, open: string, close: string): string {
  const first = text.indexOf(open)
  const last = text.lastIndexOf(close)
  if (first === -1 || last <= first) return ''
  return text.slice(first, last + 1)
}

/**
 * Build the canonical repair message appended after a schema parse failure.
 *
 * The wording is fixed rather than adapter-specific, so the repair prompt
 * stays predictable and is easy to read back from trajectory output.
 */
export function build_repair_message(issues: ReadonlyArray<SchemaIssue>): Message {
  return { role: 'user', content: build_repair_prompt_text(issues) }
}

/**
 * String form of the repair prompt for transports (subprocess CLIs) that take
 * a single stdin string rather than a Message. Same wording as
 * build_repair_message so the on-wire instruction is identical across providers.
 */
export function build_repair_prompt_text(issues: ReadonlyArray<SchemaIssue>): string {
  const serialized = format_schema_issues(issues)
  return (
    `Your previous response did not match the expected schema. Error: ${serialized}. ` +
    'Please provide a corrected response that strictly conforms to the schema. ' +
    'Return ONLY the JSON value: no markdown code fences, no surrounding prose, no commentary.'
  )
}

/**
 * Throw schema_validation_error carrying the schema issues and the raw model text.
 * Called by the orchestrator when all repair attempts are exhausted.
 */
export function throw_schema_validation(
  issues: ReadonlyArray<SchemaIssue>,
  raw_text: string,
): never {
  throw new schema_validation_error(
    `schema validation failed: ${format_schema_issues(issues)}`,
    issues,
    raw_text,
  )
}
