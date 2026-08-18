/**
 * sequence: chain child outputs.
 *
 * `sequence([a, b, c])` runs a, b, c in declared order. The input to sequence
 * is passed to the first child; each subsequent child receives the previous
 * child's output. The composer returns the last child's output.
 *
 * For a literal tuple of children, every joint is checked at compile time:
 * each child after the first must accept its predecessor's output, and a
 * mismatch resolves the offending element to a branded SequenceJointMismatch
 * so the error names the joint and both types. A spread segment inside a
 * tuple (`sequence([first, ...mids, last])`) is checked as a homogeneous
 * self-composing segment rather than index-zipped, since its positions are
 * not statically known. Arrays built at runtime carry no positional types,
 * so they must be homogeneous `ReadonlyArray<Step<T, T>>` and produce a
 * `Step<T, T>`; heterogeneous runtime arrays are rejected rather than
 * silently degrading to `Step<unknown, unknown>`.
 */

import { is_step } from './is_step.js'
import { dispatch_step, register_traced_kind, throw_if_aborted } from './runner.js'
import type { AnyStep, RunContext, Step, StepInput, StepOutput } from './types.js'

type FirstInput<children> = children extends readonly [Step<infer i, unknown>, ...unknown[]]
  ? i
  : unknown

type LastOutput<children> = children extends readonly [...unknown[], Step<never, infer o>]
  ? o
  : children extends readonly [Step<never, infer o>]
    ? o
    : unknown

type OutputOf<s> = StepOutput<s>

// `never` fallback so a non-step can never satisfy a joint by accident.
type InputOf<s> = StepInput<s>

// Branded impossible type for joint failures. A mismatched element's expected
// type resolves to this interface, so the first line of the compile error
// names the joint position and both types instead of burying them under a
// structural Step assignability chain (which drags in irrelevant
// exactOptionalPropertyTypes advice).
interface SequenceJointMismatch<at extends string, upstream_output, this_step_accepts> {
  readonly sequence_joint_mismatch: at
  readonly upstream_output: upstream_output
  readonly this_step_accepts: this_step_accepts
}

// The joint check: an element must be a step whose input accepts the
// upstream output. `upstream` is bracketed to suppress union distribution,
// since after a spread segment the upstream is a union and every constituent
// must be accepted, not just one.
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
type CheckedJoint<element, upstream, at extends string> = unknown extends element
  ? unknown
  : element extends AnyStep
    ? [upstream] extends [InputOf<element>]
      ? element
      : SequenceJointMismatch<at, upstream, InputOf<element>>
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
// tuple instead of recursion, so length is unbounded. Only sound for tuples
// without a spread segment, where `k` is a real position; CheckedChildren
// routes spread-bearing tuples to CheckedSpreadTail instead.
type CheckedTail<children extends readonly unknown[], rest extends readonly unknown[]> = {
  readonly [k in keyof rest]: CheckedJoint<
    rest[k],
    OutputOf<k extends keyof children ? children[k] : never>,
    `after children[${k & string}]`
  >
}

// True only for spread segments and plain runtime arrays: any tuple with a
// fixed element fails the mutual assignability probe on length grounds.
type IsPlainArray<t extends readonly unknown[]> = t extends readonly []
  ? false
  : t[number][] extends [...t]
    ? true
    : false

// A spread segment admits any length including zero, so each element must
// accept both the upstream output (it may run first) and its own output (it
// may follow a sibling). `e` is bracketed against distribution so a union
// element type is checked as a whole, where InputOf infers the intersection
// of inputs and OutputOf the union of outputs, which is exactly the sound
// requirement.
type CheckedSegment<seg extends readonly unknown[], e, upstream> = unknown extends e
  ? seg
  : [e] extends [AnyStep]
    ? [upstream | OutputOf<e>] extends [InputOf<e>]
      ? seg
      : readonly SequenceJointMismatch<'spread segment', upstream | OutputOf<e>, InputOf<e>>[]
    : readonly AnyStep[]

// Peels fixed trailing elements off a spread-first remainder until only the
// spread segment is left. The head-infer pattern fails on a leading spread,
// so recursion arrives here exactly when the segment is at the front.
type SplitSpreadTrail<
  t extends readonly unknown[],
  trail extends readonly unknown[] = [],
> = IsPlainArray<t> extends true
  ? [t, trail]
  : t extends readonly [...infer init, infer last_el]
    ? SplitSpreadTrail<init, [last_el, ...trail]>
    : [t, trail]

// Position tracker for joint labels: a counting tuple while positions are
// statically known, the 'spread' marker once a spread segment has consumed
// the absolute indices.
type SpreadPos = readonly unknown[] | 'spread'

type JointAt<p extends SpreadPos> = p extends readonly unknown[]
  ? `after children[${p['length']}]`
  : 'after spread segment'

type NextPos<p extends SpreadPos> = p extends readonly unknown[] ? readonly [...p, unknown] : p

// Walks a tuple that contains a spread segment. Fixed heads are joint-checked
// with exact labels; the segment itself goes through CheckedSegment; fixed
// elements after the segment are checked against the upstream widened by the
// segment's output, because the segment may be empty at run time and both
// paths must be sound. Recursion is fine here: spread-bearing tuples have few
// fixed elements, while the unbounded fixed-tuple case keeps the mapped zip.
type CheckedSpreadTail<
  upstream,
  t extends readonly unknown[],
  p extends SpreadPos,
> = t extends readonly []
  ? readonly []
  : IsPlainArray<t> extends true
    ? readonly [...CheckedSegment<t, t[number], upstream>]
    : t extends readonly [infer h, ...infer r]
      ? readonly [
          CheckedJoint<h, upstream, JointAt<p>>,
          ...CheckedSpreadTail<OutputOf<h>, r, NextPos<p>>,
        ]
      : SplitSpreadTrail<t> extends [
            infer seg extends readonly unknown[],
            infer trail extends readonly unknown[],
          ]
        ? readonly [
            ...CheckedSegment<seg, seg[number], upstream>,
            ...CheckedSpreadTail<upstream | OutputOf<seg[number]>, trail, 'spread'>,
          ]
        : never

// Rejection brands: both are impossible to satisfy, so the checked overload
// fails and the call either falls through to the homogeneous array overload
// or errors with the brand's name and advice on the first line.
interface SequenceRuntimeChildrenMustBeHomogeneous<element> {
  readonly runtime_built_children: 'no tuple positions to check; use ReadonlyArray<Step<T, T>>'
  readonly element: element
}

interface SequenceLeadingSpreadNeedsFixedFirst {
  readonly leading_spread: 'joint checking needs a fixed first element; a homogeneous ReadonlyArray<Step<T, T>> works via the array overload'
}

// `unknown[] extends children` is true only for the degenerate constraint
// instantiation (and a genuine unknown[] argument), which must stay
// contextually inert. Plain runtime arrays are rejected here so the call
// falls through to the homogeneous overload instead of degrading to
// `Step<unknown, unknown>`. `number extends length` detects a spread segment
// somewhere in the tuple; the trailing `children` fallback only fires for
// the empty tuple.
type CheckedChildren<children extends readonly unknown[]> = unknown[] extends children
  ? children
  : IsPlainArray<children> extends true
    ? SequenceRuntimeChildrenMustBeHomogeneous<children[number]>
    : number extends children['length']
      ? children extends readonly [infer first, ...infer rest]
        ? readonly [CheckedFirst<first>, ...CheckedSpreadTail<OutputOf<first>, rest, readonly []>]
        : SequenceLeadingSpreadNeedsFixedFirst
      : children extends readonly [infer first, ...infer rest]
        ? readonly [CheckedFirst<first>, ...CheckedTail<children, rest>]
        : children

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
 * constrains it. Runtime-built arrays carry no positional types, so the
 * second overload requires them to be homogeneous and self-composing, which
 * keeps `run` sound instead of degrading to the unknown boundary. Validates
 * every element up front so a non-Step (usually a bare function) fails at
 * construction with a pointed message rather than at run time. Checks
 * `ctx.abort` before each child so aborts land on step boundaries.
 */
export function sequence<const children extends readonly unknown[]>(
  children: children & CheckedChildren<children>,
  options?: SequenceOptions,
): Step<FirstInput<children>, LastOutput<children>>
export function sequence<t>(
  children: ReadonlyArray<Step<t, t>>,
  options?: SequenceOptions,
): Step<t, t>
export function sequence(children: readonly unknown[], options?: SequenceOptions): AnyStep {
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

  return {
    id,
    kind: 'sequence',
    children: children_ref,
    ...(config_meta ? { config: config_meta } : {}),
    run: run_fn,
  }
}

register_traced_kind('sequence')
