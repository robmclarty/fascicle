/**
 * Typed read of the claude CLI's `provider_reported` entry.
 *
 * `provider_reported` is keyed by provider and opaque to the engine, so a
 * consumer would otherwise re-declare the claude_cli shape at every use site
 * to narrow `provider_reported['claude_cli']`.
 */

import type { ClaudeCliProviderReported } from './types.js'

/**
 * Read the claude CLI's reported run detail off anything carrying
 * `provider_reported`: a `GenerateResult`, a `StepRecord`, or an
 * `incomplete_generation_error`.
 *
 * Returns undefined when the source has no `claude_cli` entry, or when the
 * entry lacks a string `session_id` and a numeric `duration_ms`.
 * `duration_api_ms` carries through only when it is a number.
 */
export function claude_cli_reported(source: {
  readonly provider_reported?: Readonly<Record<string, unknown>>
}): ClaudeCliProviderReported | undefined {
  const entry = source.provider_reported?.['claude_cli']
  if (typeof entry !== 'object' || entry === null) return undefined
  const session_id: unknown = Reflect.get(entry, 'session_id')
  const duration_ms: unknown = Reflect.get(entry, 'duration_ms')
  if (typeof session_id !== 'string' || typeof duration_ms !== 'number') return undefined
  const duration_api_ms: unknown = Reflect.get(entry, 'duration_api_ms')
  return typeof duration_api_ms === 'number'
    ? { session_id, duration_ms, duration_api_ms }
    : { session_id, duration_ms }
}
