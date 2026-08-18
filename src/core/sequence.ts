/**
 * sequence: chain child outputs.
 *
 * `sequence([a, b, c])` runs a, b, c in declared order. The input to sequence
 * is passed to the first child; each subsequent child receives the previous
 * child's output. The composer returns the last child's output.
 *
 * For a literal tuple of children, every joint is checked at compile time:
 * each child after the first must accept its predecessor's output, and a
 * mismatch errors on the offending element. Arrays built at runtime carry no
 * positional types, so they degrade to the outer boundary (`unknown` in and
 * out) while each element is still checked to be a Step.
 */

import { is_step } from './is_step.js'
import { dispatch_step, register_traced_kind, throw_if_aborted } from './runner.js'
import type { AnyStep, RunContext, Step } from './types.js'

type FirstInput<children> = children extends readonly [Step<infer i, unknown>, ...unknown[]]
  ? i
  : unknown

type LastOutput<children> = children extends readonly [...unknown[], Step<never, infer o>]
  ? o
  : children extends readonly [Step<never, infer o>]
    ? o
    : unknown

type OutputOf<s> = s extends Step<never, infer o> ? o : unknown

// The joint check: an element must be a step whose input accepts the
// predecessor's output, which sound contravariance expresses as plain
// assignability to `Step<OutputOf<prev>, OutputOf<element>>`.
//
// The `unknown extends element` guard is load-bearing. While `children` is
// being inferred, the checker computes contextual types for the array literal
// from this parameter type instantiated with degenerate stand-ins (the type
// parameter's constraint and the infer variables' constraints), under which
// every element resolves to `unknown`. The guard collapses those
// instantiations to the inert contextual type `unknown`, so an inline
// generic leaf (a bare `model_step({ ... })`) resolves its own type
// parameters from its arguments and defaults instead of absorbing `unknown`
// from a step-shaped context. No concrete element is typed as exactly
// `unknown`, so real elements always reach the checking branches.
type CheckedJoint<element, prev> = unknown extends element
  ? unknown
  : element extends AnyStep
    ? Step<OutputOf<prev>, OutputOf<element>>
    : AnyStep

// First position has no predecessor: any step passes, a non-step fails
// against AnyStep. Guarded like CheckedJoint, for the same reason.
type CheckedFirst<element> = unknown extends element
  ? unknown
  : element extends AnyStep
    ? element
    : AnyStep

// Index-zips the tail against the full tuple: `rest` is `children` shifted
// left by one, so `children[k]` is the predecessor of `rest[k]`. A mapped
// tuple instead of recursion, so length is unbounded.
type CheckedTail<children extends readonly unknown[], rest extends readonly unknown[]> = {
  readonly [k in keyof rest]: CheckedJoint<
    rest[k],
    k extends keyof children ? children[k] : never
  >
}

// Non-tuple fallback: `unknown[] extends children` is true only for the
// degenerate constraint instantiation (and a genuine unknown[] argument),
// which must stay contextually inert; every concrete runtime-built array
// falls through to `readonly AnyStep[]`, so each element is still checked
// to be a Step while the joints degrade to the outer boundary.
type CheckedChildren<children extends readonly unknown[]> = children extends readonly [
  infer first,
  ...infer rest,
]
  ? readonly [CheckedFirst<first>, ...CheckedTail<children, rest>]
  : unknown[] extends children
    ? children
    : readonly AnyStep[]

let sequence_counter = 0

/**
 * Generate a unique step id of the form `sequence_<n>`.
 */
function next_id(): string {
  sequence_counter += 1
  return `sequence_${sequence_counter}`
}

export type SequenceOptions = {
  readonly name?: string
}

/**
 * Build a step that chains children, each feeding the next.
 *
 * The children parameter is checked joint by joint for literal tuples via
 * `CheckedChildren`; the intersection with the bare `children` parameter is
 * what lets inference read the precise tuple while the checked shape
 * constrains it. Validates every element up front so a non-Step (usually a
 * bare function) fails at construction with a pointed message rather than at
 * run time. Checks `ctx.abort` before each child so aborts land on step
 * boundaries.
 */
export function sequence<const children extends readonly unknown[]>(
  children: children & CheckedChildren<children>,
  options?: SequenceOptions,
): Step<FirstInput<children>, LastOutput<children>> {
  if (!Array.isArray(children)) {
    throw new TypeError(
      `sequence(children): children must be an array of Steps, got ${typeof children} — sequence takes a single array, e.g. sequence([a, b, c])`,
    )
  }
  children.forEach((child: unknown, index: number) => {
    if (is_step(child)) return
    const hint =
      typeof child === 'function'
        ? ' — wrap plain functions with step(fn), or use pipe(inner, fn) to transform output'
        : ''
    throw new TypeError(
      `sequence(children): children[${index}] is not a Step, got ${typeof child}${hint}`,
    )
  })

  const id = next_id()
  // Validation above guarantees every element is a Step; the compile-time
  // story lives in CheckedChildren, so the erased view is a plain step array.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const children_ref = children as readonly AnyStep[]
  const run_fn = async (input: unknown, ctx: RunContext): Promise<unknown> => {
    let acc: unknown = input
    for (const child of children_ref) {
      throw_if_aborted(ctx)
      // The erased list drops the joint types; the checked signature pairs
      // each child with its predecessor's output, so the dispatch re-asserts.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      acc = await dispatch_step(child, acc as never, ctx)
    }
    return acc
  }

  const config_meta: Record<string, unknown> | undefined =
    options?.name === undefined ? undefined : { display_name: options.name }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    id,
    kind: 'sequence',
    children: children_ref,
    ...(config_meta ? { config: config_meta } : {}),
    run: run_fn,
  } as Step<FirstInput<children>, LastOutput<children>>
}

register_traced_kind('sequence')
