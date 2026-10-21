/**
 * Naming the parts of a named composite for `describe.diagram`.
 *
 * A composite draws as one node over the steps that its caller passed in, each
 * under the role the composite gives it, and those roles can collide: a member
 * named `score` beside the judge, or a gate whose id is its inner step's id.
 */

import type { AnyStep } from '#core'

/**
 * Collect parts by role, giving a role that's already taken a numbered
 * suffix, so every part is still drawn.
 */
export function name_parts(entries: ReadonlyArray<readonly [string, AnyStep]>): Record<string, AnyStep> {
  const parts: Record<string, AnyStep> = {}
  for (const [role, part] of entries) {
    let name = role
    for (let n = 2; Object.hasOwn(parts, name); n += 1) name = `${role}_${n}`
    parts[name] = part
  }
  return parts
}
