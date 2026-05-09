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
 * Even with --json-schema enforcement, models occasionally wrap structured
 * output in markdown fences and surrounding prose. We try a sequence of
 * candidates in increasing leniency: the trimmed text as-is, every fenced
 * block in the text, and the outermost {…} / […] slice. The first candidate
 * that both parses as JSON and matches the schema wins. The last error
 * encountered is surfaced if every candidate fails.
 */
export function parse_with_schema<t>(
  schema: z.ZodType<t>,
  text: string,
): ParseOutcome<t> {
  const candidates = json_candidates(text)
  let last_error: unknown = new Error('No JSON-parseable content found in model output')
  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch (err: unknown) {
      last_error = err
      continue
    }
    const result = schema.safeParse(parsed)
    if (result.success) return { ok: true, value: result.data }
    last_error = result.error
  }
  return { ok: false, error: last_error }
}

const FENCE_BLOCK = /```(?:[\w-]*)\s*\n?([\s\S]*?)\n?```/g

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

function slice_outermost(text: string, open: string, close: string): string {
  const first = text.indexOf(open)
  const last = text.lastIndexOf(close)
  if (first === -1 || last <= first) return ''
  return text.slice(first, last + 1)
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
