/**
 * compose: name a composite step.
 *
 * `compose(name, inner)` wraps any step and labels its trajectory span with
 * `name`. The inner step's own span (e.g. a `sequence`) appears as a child of
 * the compose span — the implementation tree is preserved while the user's
 * intent ("this whole thing is an ensemble") is surfaced in observability.
 *
 * Used by the @repo/composites package to make built-in patterns appear under
 * their familiar names, and available to library consumers who want their own
 * named composites to show up in logs as first-class components.
 *
 * The primitive's `kind` is always `'compose'`; the user-supplied label lives
 * in `config.display_name` and is the span name the dispatcher opens.
 */

import { dispatch_step, register_kind, resolve_span_label } from './runner.js'
import type { RunContext, Step } from './types.js'

let compose_counter = 0

function next_id(name: string): string {
  compose_counter += 1
  return `${name}_${compose_counter}`
}

export function compose<i, o>(name: string, inner: Step<i, o>): Step<i, o> {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('compose(name, inner): name must be a non-empty string')
  }
  const id = next_id(name)

  const run_fn = (input: i, ctx: RunContext): Promise<o> | o => dispatch_step(inner, input, ctx)

  return {
    id,
    kind: 'compose',
    children: [inner],
    config: { display_name: name },
    run: run_fn,
  }
}

register_kind('compose', async (flow, input, ctx) => {
  const label = resolve_span_label(flow, 'compose')
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
