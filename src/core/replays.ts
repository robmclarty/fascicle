/**
 * The analysis behind `describe.replays(step)`: which steps marked
 * `side_effect` a resumed run can run again before it reaches a gate.
 *
 * A run that resumes at a `suspend` replays the flow from its input, so a step
 * that ran before the gate runs again, unless a `checkpoint` stored its
 * result. The runtime reports each one as a `step_replayed` event once it has
 * happened. This finds them from the flow's shape alone, before anything runs,
 * so an app can hold its flow to having none in a test.
 *
 * It reads only the `FlowNode` tree that `describe.json` produces. A marked
 * step can replay at a gate when it can start before the gate in one pass and
 * no checkpoint stores its result first. Where the two paths split decides
 * which comes first:
 *
 * - `parallel` members start together, and a step's arms run in whatever
 *   order its body calls them, so either one can.
 * - The arms of a `branch` exclude each other within a pass, so neither does.
 * - Anything else runs its children in order: a `sequence`, a `chain`'s plan,
 *   a `fallback`'s primary before its backup, a `loop`'s body before its guard
 *   within a round, and a kind this module doesn't know.
 * - A step that holds the gate starts before it.
 *
 * A checkpoint protects a step from a gate when it holds the step and not the
 * gate. One around both stores its result only after the gate resumes.
 *
 * What the tree can't show, this can't see: a model call that a step's body
 * makes without declaring it as an arm, a step that a `suspend`'s `combine`
 * hands back, and a gate that a loop reaches only in a later round.
 */

import { label_of } from './node_label.js'
import type { FlowNode } from './types.js'

/**
 * A step that a resumed run can run again: its `id`, the `label` its row
 * carries in `describe.diagram`, and the ids of the gates it can run before,
 * in flow order.
 */
export type ReplayHint = {
  readonly id: string
  readonly label: string
  readonly gates: ReadonlyArray<string>
}

type Turn = {
  readonly node: FlowNode
  readonly index: number
}

// A node with the turns that lead to it from the root: each ancestor, root
// first, and the index of the child the path takes under it.
type Visit = {
  readonly node: FlowNode
  readonly trail: ReadonlyArray<Turn>
}

/**
 * Append `node` and every node under it to `out`, in reading order.
 */
function walk(node: FlowNode, trail: ReadonlyArray<Turn>, out: Visit[]): void {
  out.push({ node, trail })
  for (const [index, child] of (node.children ?? []).entries()) {
    walk(child, [...trail, { node, index }], out)
  }
}

/**
 * True when, under a node of `kind`, the child at `first` can start before
 * the child at `second` within one pass.
 */
function comes_first(kind: string, first: number, second: number): boolean {
  if (kind === 'branch') return false
  if (kind === 'parallel' || kind === 'step') return true
  // Stryker disable next-line EqualityOperator: two trails part where they take different children, so these indexes are never equal and <= reads like <.
  return first < second
}

/**
 * How many turns two trails share before they part, which is the depth of
 * the node where their paths split. A trail that runs out first is shared
 * whole.
 */
function shared_depth(a: ReadonlyArray<Turn>, b: ReadonlyArray<Turn>): number {
  const parted = a.findIndex((turn, i) => turn.index !== b[i]?.index)
  return parted === -1 ? a.length : parted
}

/**
 * True when the marked step at `s` can run before the gate at `g` with no
 * checkpoint between them that holds the step and not the gate.
 */
function runs_before(s: Visit, g: Visit): boolean {
  const depth = shared_depth(s.trail, g.trail)
  const split_s = s.trail[depth]
  const split_g = g.trail[depth]
  // The gate holds the step, which only a hand-built tree can arrange, or the
  // two are the same node. Either way the step can't start first.
  if (split_g === undefined) return false
  // The step holds the gate, so it starts first.
  if (split_s === undefined) return true
  if (!comes_first(split_s.node.kind, split_s.index, split_g.index)) return false
  return !s.trail.slice(depth + 1).some(({ node }) => node.kind === 'checkpoint')
}

/**
 * The gates each marked node can run before, by node, for every marked node
 * that has any. A gate that appears twice in the tree is listed once.
 */
export function replay_gates(root: FlowNode): ReadonlyMap<FlowNode, ReadonlyArray<string>> {
  const visits: Visit[] = []
  // Stryker disable next-line ArrayDeclaration: an extra entry at the head of every trail is one that all of them share, so it can't move where two trails part.
  walk(root, [], visits)
  const gates = visits.filter(({ node }) => node.kind === 'suspend')
  const found = new Map<FlowNode, ReadonlyArray<string>>()
  for (const visit of visits) {
    if (visit.node.meta?.side_effect !== true) continue
    const ids = [...new Set(gates.filter((gate) => runs_before(visit, gate)).map(({ node }) => node.id))]
    if (ids.length > 0) found.set(visit.node, ids)
  }
  return found
}

/**
 * Every step marked `side_effect` that a resumed run can run again before one
 * of the flow's gates, in flow order. A step that appears twice in the tree
 * gets one hint, with the gates of both places.
 */
export function find_replays(root: FlowNode): ReadonlyArray<ReplayHint> {
  const by_id = new Map<string, ReplayHint>()
  for (const [node, gates] of replay_gates(root)) {
    const seen = by_id.get(node.id)
    by_id.set(node.id, {
      id: node.id,
      label: label_of(node).label,
      gates: seen === undefined ? gates : [...new Set([...seen.gates, ...gates])],
    })
  }
  return [...by_id.values()]
}
