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

import type { AnyStep } from './types.js'

/**
 * Resolve the human-readable label for `node`, falling back to `fallback`
 * (typically the step's kind) when neither display channel is populated.
 */
export function resolve_display_name(node: AnyStep, fallback: string): string {
  const display = node.config?.['display_name']
  if (typeof display === 'string' && display.length > 0) return display
  const name = node.meta?.name
  if (typeof name === 'string' && name.length > 0) return name
  return fallback
}
