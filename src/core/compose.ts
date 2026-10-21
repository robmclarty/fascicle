/**
 * compose: name a composite step.
 *
 * `compose(inner, { name })` wraps any step and labels its trajectory span
 * with `name`. The inner step's own span (for example, a `sequence`) appears
 * as a child of the compose span: the implementation tree is preserved while
 * the user's intent ("this whole thing is an ensemble") is surfaced in
 * observability.
 *
 * Used by the composites package to make built-in patterns appear under
 * their familiar names, and available to library consumers who want their own
 * named composites to show up in logs as first-class components.
 *
 * The primitive's `kind` is always `'compose'` and its id is `compose_<n>`.
 * The user-supplied label lives in `config.display_name`, is the span name
 * the dispatcher opens, and never reaches the id: it is free prose, so
 * folding it in would let a cosmetic rename move a trajectory id.
 */

import { description_meta } from './display_name.js'
import { dispatch_step, register_traced_kind } from './runner.js'
import type { AnyStep, RunContext, Step } from './types.js'

export type ComposeConfig = {
  readonly name: string
  // Admits an explicit undefined so a named composite can forward its own
  // optional description without a conditional spread.
  readonly description?: string | undefined
  // The steps, by role, that a reader should see when the composite is drawn.
  // Each has to sit somewhere inside `inner`. `describe.diagram` draws the
  // composite as one node over these, and `{ internals: true }` draws `inner`.
  readonly parts?: Readonly<Record<string, AnyStep>> | undefined
}

let compose_counter = 0

/**
 * Generate a unique step id of the form `compose_<n>`.
 */
function next_id(): string {
  compose_counter += 1
  return `compose_${compose_counter}`
}

/**
 * Wrap `inner` in a named composite step.
 *
 * The step's `kind` is always `'compose'`; `config.name` becomes the
 * `display_name` used as the span label. Throws a `TypeError` when `name`
 * is not a non-empty string, catching the mistake at construction time.
 *
 * Each of `config.parts` is recorded as the path of child indices that leads
 * to it from the composite, so `describe.json` keeps the whole tree that the
 * viewer maps spans onto while `describe.diagram` can draw just the parts. A
 * part that isn't inside `inner` throws, since there would be no path to draw.
 */
export function compose<i, o>(inner: Step<i, o>, config: ComposeConfig): Step<i, o> {
  const name = config?.name
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('compose(inner, { name }): name must be a non-empty string')
  }
  const parts = part_paths(inner, config.parts)
  const id = next_id()

  const run_fn = (input: i, ctx: RunContext): Promise<o> | o => dispatch_step(inner, input, ctx)

  return {
    id,
    kind: 'compose',
    children: [inner],
    config: parts === undefined ? { display_name: name } : { display_name: name, parts },
    ...description_meta(config.description),
    run: run_fn,
  }
}

/**
 * The path of child indices from the composite to each part, by role, or
 * `undefined` when there are no parts. Every path starts at `inner`, the
 * composite's only child.
 */
function part_paths(
  inner: AnyStep,
  parts: Readonly<Record<string, AnyStep>> | undefined,
): Readonly<Record<string, ReadonlyArray<number>>> | undefined {
  if (parts === undefined) return undefined
  const paths: Record<string, ReadonlyArray<number>> = {}
  for (const [role, part] of Object.entries(parts)) {
    const path = path_to(inner, part, new Set())
    if (path === undefined) {
      throw new TypeError(
        `compose(inner, { parts }): part "${role}" (${part.kind} ${part.id}) is not inside inner, so the diagram would have nothing to draw for it`,
      )
    }
    paths[role] = [0, ...path]
  }
  return paths
}

/**
 * The child indices that lead from `from` to `target`, found depth first by
 * identity, or `undefined` when `target` isn't below it. `seen` keeps a shared
 * step from being walked twice.
 */
function path_to(from: AnyStep, target: AnyStep, seen: Set<AnyStep>): ReadonlyArray<number> | undefined {
  if (from === target) return []
  if (seen.has(from)) return undefined
  seen.add(from)
  const children = from.children
  if (children === undefined) return undefined
  for (const [index, child] of children.entries()) {
    const rest = path_to(child, target, seen)
    if (rest !== undefined) return [index, ...rest]
  }
  return undefined
}

register_traced_kind('compose')
