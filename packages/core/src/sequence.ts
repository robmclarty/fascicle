/**
 * sequence: chain child outputs.
 *
 * `sequence([a, b, c])` runs a, b, c in declared order. The input to sequence
 * is passed to the first child; each subsequent child receives the previous
 * child's output. The composer returns the last child's output.
 *
 * See spec.md §5.2 and §6.1.
 */

import { dispatch_step, register_kind, resolve_span_label } from './runner.js'
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
  const id = next_id()
  const children_ref = children
  const run_fn = async (input: unknown, ctx: RunContext): Promise<unknown> => {
    let acc: unknown = input
    for (const child of children_ref) {
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

register_kind('sequence', async (flow, input, ctx) => {
  const label = resolve_span_label(flow, 'sequence')
  const span_id = ctx.trajectory.start_span(label, { id: flow.id })
  try {
    const out = await flow.run(input, ctx)
    ctx.trajectory.end_span(span_id, { id: flow.id })
    return out
  } catch (err) {
    ctx.trajectory.end_span(span_id, {
      id: flow.id,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
})
