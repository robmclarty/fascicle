/**
 * Closed registry of every `Step.kind` produced by the composition layer.
 *
 * Studio (and any other consumer that needs to enumerate primitives — palette,
 * docs, code generation) can rely on this being the exhaustive set. New
 * primitives must add their kind here. The `step_kinds_cover_runner` contract
 * test in `step_kinds.test.ts` asserts every dispatch handler corresponds to a
 * kind listed here.
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
] as const;

export type StepKind = (typeof STEP_KINDS)[number];

export function is_step_kind(value: unknown): value is StepKind {
  return typeof value === 'string' && (STEP_KINDS as readonly string[]).includes(value);
}
