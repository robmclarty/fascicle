/**
 * Schema parse and repair helpers.
 *
 * The tool-loop / generate orchestrator (phase 2) owns the repair loop itself
 * (counting toward max_steps, re-dispatching through the provider). This
 * module exposes the parse primitive and the canonical repair-prompt shape.
 */

import type { z } from 'zod';
import type { Message } from './types.js';
import { schema_validation_error } from './errors.js';

export type ParseOutcome<t> =
  | { ok: true; value: t }
  | { ok: false; error: unknown };

/**
 * Attempt to parse `text` as JSON and validate it with `schema`. Returns a
 * tagged union; the caller decides whether to escalate to repair, throw, or
 * surface the failure.
 */
export function parse_with_schema<t>(
  schema: z.ZodType<t>,
  text: string,
): ParseOutcome<t> {
  let parsed_json: unknown;
  try {
    parsed_json = JSON.parse(text);
  } catch (err: unknown) {
    return { ok: false, error: err };
  }
  const result = schema.safeParse(parsed_json);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error };
}

/**
 * Build the canonical repair message appended after a schema parse failure.
 * Content mirrors spec §6.5 exactly so the repair prompt is predictable and
 * user-inspectable in trajectory output.
 */
export function build_repair_message(zod_error: unknown): Message {
  const serialized = format_zod_error(zod_error);
  return {
    role: 'user',
    content:
      `Your previous response did not match the expected schema. Error: ${serialized}. ` +
      'Please provide a corrected response that strictly conforms to the schema.',
  };
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
  );
}

function format_zod_error(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
  }
  try {
    return JSON.stringify(err) ?? 'unknown error';
  } catch {
    return 'unknown error';
  }
}
