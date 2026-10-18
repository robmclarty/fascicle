/**
 * Closed registry of every `Step.kind` produced by the composition layer.
 *
 * The viewer (and any other consumer that needs to enumerate primitives:
 * palette, docs, code generation) can rely on this being the exhaustive set. New
 * primitives must add their kind here. `step_kinds.test.ts` pins the list
 * against the kinds core actually constructs, in both directions. The
 * composites (`ensemble`, `tournament`, and the rest) add no kinds of their
 * own: each builds a `compose` step that carries its name as the display name.
 */

export const STEP_KINDS = [
  'step',
  'sequence',
  'parallel',
  'branch',
  'map',
  'pipe',
  'retry',
  'fallback',
  'timeout',
  'loop',
  'compose',
  'checkpoint',
  'suspend',
  'scope',
  'stash',
  'use',
  'chain',
] as const

export type StepKind = (typeof STEP_KINDS)[number]

/**
 * Check whether a value is one of the registered `Step.kind` strings.
 */
export function is_step_kind(value: unknown): value is StepKind {
  return typeof value === 'string' && (STEP_KINDS as readonly string[]).includes(value)
}
