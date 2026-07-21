/**
 * is_step: structural Step check.
 *
 * Steps are plain objects with no brand symbol, so runtime detection is
 * structural: string `id`, string `kind`, callable `run`. Used by describe()
 * to render Step references and by combinators to validate arguments at
 * construction time.
 */

import type { Step } from './types.js'

/**
 * Check whether a value is structurally a `Step`.
 *
 * True when the value has a string `id`, a string `kind`, and a callable
 * `run`.
 */
export function is_step(value: unknown): value is Step<unknown, unknown> {
  if (typeof value !== 'object' || value === null) return false
  if (!('id' in value) || !('kind' in value) || !('run' in value)) return false
  const { id, kind, run } = value
  return typeof id === 'string' && typeof kind === 'string' && typeof run === 'function'
}
