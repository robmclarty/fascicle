/**
 * Closed registry of every `Step.kind` produced by the composition layer.
 *
 * Studio (and any other consumer that needs to enumerate primitives: palette,
 * docs, code generation) can rely on this being the exhaustive set. New
 * primitives must add their kind here. `step_kinds.test.ts` pins the list
 * against the kinds core actually constructs, and
 * `composites/__tests__/coverage.test.ts` covers the four composite kinds
 * whose factories live outside core.
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
  'adversarial',
  'ensemble',
  'tournament',
  'consensus',
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
