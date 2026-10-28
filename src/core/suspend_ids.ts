/**
 * suspend_ids: one suspend id, one place in the flow.
 *
 * Resume data is keyed by suspend id, so a `suspend` finds its datum by id
 * alone, and a second `suspend` or `gate` with the same id would pass on the
 * first one's datum without pausing. `check_suspend_ids(flow)` walks the
 * declared tree before a run starts and throws `duplicate_suspend_id_error`
 * with `reason: 'declared_twice'` for the first id, in flow order, that sits
 * in two or more places. A `gate` counts through the `suspend` inside it, and
 * one `suspend` value placed twice counts in each place.
 *
 * The walk refuses an id in two arms of a `branch` as well. Only one arm runs
 * per pass, but a resume replays the branch's condition, and a condition that
 * comes out the other way would hand one arm's approval to the other.
 *
 * The walk reads `children` and guards against a cycle with the steps on the
 * current path from the root, the way `describe` does, so a step that two
 * paths reach counts once per path, and a step that is its own ancestor is
 * skipped where it comes back. A step never changes once it's built, so the
 * answer is kept per root step and each root is walked once.
 */

import { duplicate_suspend_id_error } from './errors.js'
import type { AnyStep } from './types.js'

// One step on the way to a suspend, with its position among its parent's
// children, counted from 1, and 0 for the root.
type Frame = { readonly step: AnyStep; readonly position: number }

// A suspend's place in the tree: the frames from the root down to it.
type Place = ReadonlyArray<Frame>

type Refusal = {
  readonly suspend_id: string
  readonly paths: ReadonlyArray<ReadonlyArray<string>>
  readonly labels: ReadonlyArray<string>
  readonly at_branch: boolean
}

const refusals = new WeakMap<AnyStep, Refusal | null>()

/**
 * Add the place of every `suspend` at or under `step` to `found`, by id, in
 * the order the walk meets them. `on_path` holds the steps between the root
 * and `step`, so a step met again among its own descendants is skipped.
 */
function collect(
  step: AnyStep,
  trail: Place,
  on_path: Set<AnyStep>,
  found: Map<string, Place[]>,
): void {
  if (on_path.has(step)) return
  if (step.kind === 'suspend') found.set(step.id, [...(found.get(step.id) ?? []), trail])
  on_path.add(step)
  // Stryker disable next-line ArrayDeclaration: a stray child seeded into a leaf is no suspend, and the path guard skips the same stray child beneath it, so it adds no place.
  for (const [index, child] of (step.children ?? []).entries()) {
    collect(child, [...trail, { step: child, position: index + 1 }], on_path, found)
  }
  on_path.delete(step)
}

/**
 * The depth at which two places first go separate ways. Both start at the
 * root, and two children of one parent at one position are the same step,
 * so the first position that differs is where they part, and -1 means one
 * place holds the other.
 */
function parting_depth(a: Place, b: Place): number {
  return a.findIndex((frame, depth) => frame.position !== b[depth]?.position)
}

/**
 * How the refusal names `place`: its step ids from the root, with a step's
 * position under its parent added at each depth where the place parts from
 * a twin, another place whose ids read the same. A place among its own
 * twins parts from itself at -1, which marks no step.
 */
function label_of(place: Place, twins: ReadonlyArray<Place>): string {
  const marked = new Set(twins.map((twin) => parting_depth(place, twin)))
  return place
    .map((frame, depth) => (marked.has(depth) ? `${frame.step.id} (step ${frame.position})` : frame.step.id))
    .join(' > ')
}

/**
 * The refusal for `suspend_id`, which sits at each of `places`.
 */
function refusal_for(suspend_id: string, places: ReadonlyArray<Place>): Refusal {
  const paths = places.map((place) => place.map((frame) => frame.step.id))
  const keys = paths.map((path) => JSON.stringify(path))
  const labels = places.map((place, i) =>
    label_of(
      place,
      places.filter((_, j) => keys[j] === keys[i]),
    ),
  )
  // A parting depth of -1, for a place and itself or a place and one inside
  // it, reads index -2, which holds nothing, so it never parts at a branch.
  const at_branch = places.some((a) =>
    places.some((b) => a[parting_depth(a, b) - 1]?.step.kind === 'branch'),
  )
  return { suspend_id, paths, labels, at_branch }
}

/**
 * The refusal for the first id in flow order that sits in two or more places
 * under `root`, or `null` when every id sits in one.
 */
function find_refusal(root: AnyStep): Refusal | null {
  const found = new Map<string, Place[]>()
  collect(root, [{ step: root, position: 0 }], new Set(), found)
  for (const [suspend_id, places] of found) {
    if (places.length > 1) return refusal_for(suspend_id, places)
  }
  return null
}

/**
 * Throw `duplicate_suspend_id_error` when `root` holds one suspend id in two
 * or more places. The runner calls this before the first step of every run,
 * and the answer is kept per root, so a flow is walked once however often it
 * runs.
 */
export function check_suspend_ids(root: AnyStep): void {
  let refusal = refusals.get(root)
  if (refusal === undefined) {
    refusal = find_refusal(root)
    refusals.set(root, refusal)
  }
  if (refusal !== null) {
    throw new duplicate_suspend_id_error(refusal.suspend_id, 'declared_twice', refusal)
  }
}
