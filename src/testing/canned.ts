/**
 * Shared plumbing for the canned engine doubles.
 *
 * make_stub_engine and make_script_engine answer calls from fixtures rather
 * than a provider, but the surrounding contract stays the engine's: a call
 * under an already-aborted signal throws `aborted_error`, a streaming caller
 * sees chunks before the result resolves, and content that fails the
 * caller's schema surfaces as `schema_validation_error` carrying the issues.
 * Keeping that contract here keeps every double interchangeable with a real
 * engine at the seams tests exercise.
 */

import { aborted_error, schema_validation_error } from '#engine'
import type { FinishReason, GenerateOptions, UsageTotals } from '#engine'
import { format_schema_issues, validate_schema } from '#schema'

export const DEFAULT_USAGE: UsageTotals = { input_tokens: 40, output_tokens: 20 }

/**
 * Mirror the engine's entry guard: a generate call under an already-aborted
 * signal never reaches a provider, so a double must refuse it the same way
 * for cancellation tests to be trustworthy.
 */
export function throw_if_aborted(abort: AbortSignal | undefined): void {
  if (abort?.aborted === true) {
    throw new aborted_error('aborted', { reason: abort.reason })
  }
}

/**
 * Render canned content as the text a provider would have put on the wire:
 * strings pass through, everything else is serialized as JSON (which is what
 * a schema-bearing call would have streamed).
 */
function render_text(content: unknown): string {
  if (typeof content === 'string') return content
  return JSON.stringify(content) ?? ''
}

/**
 * Emit the minimal chunk sequence a streaming caller expects: the whole
 * content as one text chunk, then the finish marker. Enough for model_chunk
 * trajectory events and stream-consuming UIs to fire without a network.
 */
export async function emit_chunks(
  on_chunk: GenerateOptions['on_chunk'],
  content: unknown,
  finish_reason: FinishReason,
  usage: UsageTotals,
): Promise<void> {
  if (on_chunk === undefined) return
  await on_chunk({ kind: 'text', text: render_text(content), step_index: 0 })
  await on_chunk({ kind: 'finish', finish_reason, usage })
}

/**
 * Validate canned content through the caller's schema, throwing the engine's
 * own `schema_validation_error` on failure so `instanceof` handling in the
 * code under test sees exactly what a real engine throws when its repair
 * attempts run out. The issues are normalized and rendered by the same
 * `#schema` helpers the engine uses. Absent a schema, the content passes
 * through untouched.
 */
export async function validate_canned(
  schema: GenerateOptions<unknown>['schema'],
  content: unknown,
  described: string,
): Promise<unknown> {
  if (schema === undefined) return content
  const checked = await validate_schema(schema, content)
  if (!checked.ok) {
    throw new schema_validation_error(
      `${described} failed the caller's schema: ${format_schema_issues(checked.issues)}`,
      checked.issues,
      render_text(content),
    )
  }
  return checked.value
}
