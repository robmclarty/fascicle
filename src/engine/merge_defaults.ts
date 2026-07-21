/**
 * Default-merging helpers for engine-level `EngineDefaults`.
 */

/**
 * Merge per-call `provider_options` over engine-level defaults.
 *
 * Scalar fields merge inline at the call site via `opts.x ?? defaults.x`, but
 * `provider_options` needs a two-level merge: outer keys are provider names
 * (`claude_cli`, `anthropic`, ...) and inner records hold per-provider
 * settings. Per-call inner keys override the matching default's inner keys;
 * provider keys unique to either side fall through unchanged. There is no
 * recursion past that second level, so deeper structures replace wholesale
 * rather than merging further.
 */
export function merge_provider_options(
  defaults: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
  call: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (defaults === undefined && call === undefined) return undefined
  if (defaults === undefined) return call
  if (call === undefined) {
    const out: Record<string, unknown> = {}
    for (const [provider, inner] of Object.entries(defaults)) {
      out[provider] = { ...inner }
    }
    return out
  }
  const out: Record<string, unknown> = {}
  for (const [provider, inner] of Object.entries(defaults)) {
    out[provider] = { ...inner }
  }
  for (const [provider, inner] of Object.entries(call)) {
    const existing = out[provider]
    if (is_plain_object(existing) && is_plain_object(inner)) {
      // Both sides are plain per-provider option records: merge their keys,
      // with the call's values winning on conflicts.
      out[provider] = { ...existing, ...inner }
    } else {
      // No default for this provider, or a non-object value on either side:
      // the call's value replaces the default wholesale.
      out[provider] = inner
    }
  }
  return out
}

/**
 * Narrow `value` to a plain (non-null, non-array) object.
 */
function is_plain_object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
