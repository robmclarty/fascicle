/**
 * The seed list of behaviors the agent must drive into the toy module,
 * one TDD cycle at a time. Each behavior is one slice of intent — the
 * agent is forbidden by prompt + structural backstop from adding more
 * than one test per RED phase.
 */

export type Behavior = {
  readonly id: string
  readonly description: string
}

export const SEED_BEHAVIORS: readonly Behavior[] = [
  {
    id: 'add_two_positives',
    description: '`add(a, b)` returns the arithmetic sum of two positive integers.',
  },
  {
    id: 'add_handles_negatives',
    description: '`add(a, b)` returns the correct sum when one or both operands are negative.',
  },
  {
    id: 'subtract_basic',
    description: '`subtract(a, b)` returns `a - b`.',
  },
]
