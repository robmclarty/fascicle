/**
 * sequence: chain child outputs.
 *
 * `sequence([a, b, c])` runs a, b, c in declared order. The input to sequence
 * is passed to the first child; each subsequent child receives the previous
 * child's output. The composer returns the last child's output.
 *
 * See spec.md §5.2 and §6.1.
 */

import { is_step } from './is_step.js'
import { dispatch_step, register_traced_kind, throw_if_aborted } from './runner.js'
import type { RunContext, Step } from './types.js'

type AnyStep = Step<unknown, unknown>

type FirstInput<children> = children extends readonly [Step<infer i, unknown>, ...unknown[]]
  ? i
  : unknown

type LastOutput<children> = children extends readonly [...unknown[], Step<unknown, infer o>]
  ? o
  : children extends readonly [Step<unknown, infer o>]
    ? o
    : unknown

let sequence_counter = 0

function next_id(): string {
  sequence_counter += 1
  return `sequence_${sequence_counter}`
}

export type SequenceOptions = {
  readonly name?: string
}

export function sequence<const children extends readonly AnyStep[]>(
  children: children,
  options?: SequenceOptions,
): Step<FirstInput<children>, LastOutput<children>> {
  if (!Array.isArray(children)) {
    throw new TypeError(
      `sequence(children): children must be an array of Steps, got ${typeof children} — sequence takes a single array, e.g. sequence([a, b, c])`,
    )
  }
  children.forEach((child, index) => {
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
  const children_ref = children
  const run_fn = async (input: unknown, ctx: RunContext): Promise<unknown> => {
    let acc: unknown = input
    for (const child of children_ref) {
      throw_if_aborted(ctx)
      acc = await dispatch_step(child, acc, ctx)
    }
    return acc
  }

  const config_meta: Record<string, unknown> | undefined =
    options?.name === undefined ? undefined : { display_name: options.name }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    id,
    kind: 'sequence',
    children,
    ...(config_meta ? { config: config_meta } : {}),
    run: run_fn,
  } as Step<FirstInput<children>, LastOutput<children>>
}

register_traced_kind('sequence')
