/**
 * Default-merging helpers for engine-level `EngineDefaults`.
 *
 * Scalar fields are merged inline at the consumer via `opts.x ?? defaults.x`.
 * `provider_options` needs a two-level merge: outer keys are provider names
 * (claude_cli, anthropic, ...) and inner records hold per-provider settings.
 * Per-call inner keys override defaults' inner keys; provider keys unique
 * to either side fall through. No recursion beyond that — deeper structures
 * replace wholesale to keep the rule predictable.
 */

export function merge_provider_options(
  defaults: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
  call: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (defaults === undefined && call === undefined) return undefined;
  if (defaults === undefined) return call;
  if (call === undefined) {
    const out: Record<string, unknown> = {};
    for (const [provider, inner] of Object.entries(defaults)) {
      out[provider] = { ...inner };
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [provider, inner] of Object.entries(defaults)) {
    out[provider] = { ...inner };
  }
  for (const [provider, inner] of Object.entries(call)) {
    const existing = out[provider];
    if (is_plain_object(existing) && is_plain_object(inner)) {
      out[provider] = { ...existing, ...inner };
    } else {
      out[provider] = inner;
    }
  }
  return out;
}

function is_plain_object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
