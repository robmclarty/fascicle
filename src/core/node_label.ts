/**
 * What a flow node is called: its display name, an id its author chose, or
 * its kind, in that order. `describe.diagram` labels its rows this way, and
 * `describe.replays` names the steps it finds the same way.
 *
 * A counter-generated id never serves as a label, because its number depends
 * on what else the process built first.
 */

import { resolve_display_name } from './display_name.js'
import { is_step_kind } from './step_kinds.js'
import type { FlowNode } from './types.js'

// Built-in kinds whose id the caller supplies. Every other built-in kind
// numbers its id from a process-wide counter.
const CHOSEN_ID_KINDS: ReadonlySet<string> = new Set(['step', 'suspend'])

/**
 * Pick a node's label: its display name, else an id its author chose, else
 * its kind. `by_kind` reports the last case, where the kind already shows.
 */
export function label_of(node: FlowNode): { readonly label: string; readonly by_kind: boolean } {
  const display = resolve_display_name(node, '')
  if (display !== '') return { label: display, by_kind: false }
  if (has_chosen_id(node)) return { label: node.id, by_kind: false }
  return { label: node.kind, by_kind: true }
}

/**
 * True when a node's id was chosen by its author. Anonymous steps, cycle
 * markers, and every built-in composer carry generated ids. A kind outside
 * the built-in set belongs to a hand-built step, whose id is its author's.
 */
export function has_chosen_id(node: FlowNode): boolean {
  if (node.anonymous === true || node.kind === '<cycle>') return false
  return !is_step_kind(node.kind) || CHOSEN_ID_KINDS.has(node.kind)
}
