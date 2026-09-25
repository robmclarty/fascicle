/**
 * Display-name resolution.
 *
 * Every consumer that renders a step for human eyes (the runner's span
 * labels, `describe`, bench reports) resolves the same way, so the order
 * lives here rather than in three copies: `config.display_name` first (what
 * composers write from their `name` option), then `meta.name` (what
 * `step(id, fn, { name })` writes), then the caller's fallback.
 *
 * Identity deliberately never participates. A step's `id` is rendered
 * separately by the consumers that want it, so renaming a step for
 * readability cannot move a checkpoint key, a resume address, or a
 * trajectory id.
 */

import type { AnyStep, StepMetadata } from './types.js'

/**
 * Resolve the human-readable label for `node`, falling back to `fallback`
 * (typically the step's kind) when neither display channel is populated.
 * It reads only `config` and `meta`, so a `describe.json` node resolves the
 * same way as the step it was drawn from.
 */
export function resolve_display_name(
  node: Pick<AnyStep, 'config' | 'meta'>,
  fallback: string,
): string {
  const display = node.config?.['display_name']
  if (typeof display === 'string' && display.length > 0) return display
  const name = node.meta?.name
  if (typeof name === 'string' && name.length > 0) return name
  return fallback
}

/**
 * The `meta` a composer spreads into the step it returns for its
 * `description` option: `meta.description` when one is given, and nothing
 * otherwise, so a composer without a description carries no empty `meta`
 * for `describe` to echo.
 */
export function description_meta(description: string | undefined): {
  readonly meta?: StepMetadata
} {
  return description === undefined ? {} : { meta: { description } }
}
