/**
 * Schema parse and repair helpers.
 *
 * The tool-loop / generate orchestrator (phase 2) owns the repair loop itself
 * (counting toward max_steps, re-dispatching through the provider). This
 * module exposes the parse primitive and the canonical repair-prompt shape.
 */

import type { z } from 'zod'
import type { Message } from './types.js'
import { schema_validation_error } from './errors.js'

export type ParseOutcome<t> =
  | { ok: true; value: t }
  | { ok: false; error: unknown }

/**
 * Attempt to parse `text` as JSON and validate it with `schema`. Returns a
 * tagged union; the caller decides whether to escalate to repair, throw, or
 * surface the failure.
 *
 * Fence tolerance: if strict JSON.parse fails, retries once with leading and
 * trailing markdown code fences stripped (e.g. ```json … ```). Models with
 * --json-schema enforcement still occasionally emit fenced output; the strict
 * path runs first so well-formed input is unaffected.
 */
export function parse_with_schema<t>(
  schema: z.ZodType<t>,
  text: string,
): ParseOutcome<t> {
  const parsed = parse_json_lenient(text)
  if (!parsed.ok) return parsed
  const result = schema.safeParse(parsed.value)
  if (result.success) return { ok: true, value: result.data }
  return { ok: false, error: result.error }
}

function parse_json_lenient(text: string): ParseOutcome<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err: unknown) {
    const stripped = strip_code_fences(text)
    if (stripped === text) return { ok: false, error: err }
    try {
      return { ok: true, value: JSON.parse(stripped) }
    } catch (err_after_strip: unknown) {
      return { ok: false, error: err_after_strip }
    }
  }
}

const FENCE_OPEN = /^```[\w-]*\s*\n?/
const FENCE_CLOSE = /\n?```\s*$/

function strip_code_fences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```') || !trimmed.endsWith('```')) return trimmed
  return trimmed.replace(FENCE_OPEN, '').replace(FENCE_CLOSE, '')
}

/**
 * Build the canonical repair message appended after a schema parse failure.
 * Content mirrors spec §6.5 exactly so the repair prompt is predictable and
 * user-inspectable in trajectory output.
 */
export function build_repair_message(zod_error: unknown): Message {
  return { role: 'user', content: build_repair_prompt_text(zod_error) }
}

/**
 * String form of the repair prompt for transports (subprocess CLIs) that take
 * a single stdin string rather than a Message. Same wording as
 * build_repair_message so the on-wire instruction is identical across providers.
 */
export function build_repair_prompt_text(zod_error: unknown): string {
  const serialized = format_zod_error(zod_error)
  return (
    `Your previous response did not match the expected schema. Error: ${serialized}. ` +
    'Please provide a corrected response that strictly conforms to the schema. ' +
    'Return ONLY the JSON value: no markdown code fences, no surrounding prose, no commentary.'
  )
}

/**
 * Throw schema_validation_error carrying the zod error and the raw model text.
 * Called by the orchestrator when all repair attempts are exhausted.
 */
export function throw_schema_validation(zod_error: unknown, raw_text: string): never {
  throw new schema_validation_error(
    `schema validation failed: ${format_zod_error(zod_error)}`,
    zod_error,
    raw_text,
  )
}

export function format_zod_error(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error'
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string') return msg
  }
  try {
    return JSON.stringify(err) ?? 'unknown error'
  } catch {
    return 'unknown error'
  }
}
