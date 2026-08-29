/**
 * The scene: the join of frozen geometry, structural captions, and folded run
 * state that the components draw verbatim.
 *
 * This module exists so the `.tsx` files can stay markup (D4). Every string
 * the canvas shows and every status a treatment keys off is decided here,
 * where the mutation gate can hold it; the renderer maps scene records to
 * elements one to one and never invents content.
 *
 * It also owns the wire session, the one place a frame's meaning is decided.
 * A `flow_structure` with a readable tree starts the canvas over for that run
 * (a long-lived file appends many runs and the header names one, Q7, so the
 * newest wins); any other frame folds into the current state. The tree is
 * read permissively (C7): nodes that do not hold their shape are dropped
 * rather than crashing layout, and a frame whose tree is unreadable keeps the
 * canvas it has instead of blanking it.
 *
 * Captions follow the T+0 honesty rule: the meta line says only what
 * structure already knows. A map child is `MAP` with no xN until instances
 * exist, a retry child reads its attempt budget from config, fallback
 * children are named seats, and the flow's final puck is the terminus. The
 * runtime overlays (RUNNING, durations, ticks) belong to later steps and are
 * deliberately absent here.
 */

import type {
  FlowLayout,
  GroupLabel,
  JunctionGlyph,
  LayoutNode,
  NodeGlyph,
} from './layout.js'
import {
  apply_event,
  initial_state,
  type CanvasState,
  type NodeStatus,
} from './reduce.js'

/**
 * Everything the app holds between frames: the structure tree the geometry
 * is laid out from, and the pure fold of every event since it arrived.
 */
export type Session = {
  readonly structure: LayoutNode | null
  readonly state: CanvasState
}

/** The session before any frame: no structure, an empty fold. */
export const EMPTY_SESSION: Session = { structure: null, state: initial_state(null) }

/**
 * Fold one wire frame into the session. A `flow_structure` carrying a
 * readable tree reseeds everything for that run: nodes start pending and the
 * event itself is folded so the run id and T+0 come off the same line. Every
 * other frame, including a `flow_structure` whose tree is unreadable, folds
 * into the current state; an unchanged fold returns the same session so the
 * renderer has nothing to re-derive.
 */
export function apply_frame(session: Session, value: unknown): Session {
  if (is_structure_frame(value)) {
    const structure = read_structure(value['structure'])
    if (structure !== null) {
      return { structure, state: apply_event(initial_state(structure), value) }
    }
  }
  const state = apply_event(session.state, value)
  return state === session.state ? session : { structure: session.structure, state }
}

/** True for a non-array object announcing a structure tree. */
function is_structure_frame(value: unknown): value is Readonly<Record<string, unknown>> {
  return is_record(value) && value['kind'] === 'flow_structure'
}

/** True when the value is a plain record: a bag of fields, not an array. */
function is_record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a wire value as a structure tree. A node must be a non-array object
 * with string `kind` and `id`; children that fail the test vanish, config
 * survives only as a record, and anything else is dropped whole. Absent
 * children and config are omitted rather than set empty, so a sanitized tree
 * of a well-formed wire line is equal to the line's own.
 */
function read_structure(value: unknown): LayoutNode | null {
  if (!is_record(value)) return null
  const kind = value['kind']
  const id = value['id']
  if (typeof kind !== 'string' || typeof id !== 'string') return null
  const raw_children = value['children']
  const children = Array.isArray(raw_children)
    ? raw_children
        .map(read_structure)
        .filter((child): child is LayoutNode => child !== null)
    : []
  const config = value['config']
  return {
    kind,
    id,
    ...(is_record(config) ? { config } : {}),
    ...(children.length === 0 ? {} : { children }),
  }
}

/**
 * The structural caption for every node id: what the meta line knows before
 * any span arrives. A combinator frames its children; everything else wears
 * its own kind in the caption register. First id wins, so a `<cycle>`
 * back-reference or a shared step keeps the caption of the node that owns
 * the id, matching the fold's join.
 */
export function node_captions(structure: LayoutNode | null): ReadonlyMap<string, string> {
  const captions = new Map<string, string>()
  if (structure !== null) collect_captions(structure, captions)
  return captions
}

/**
 * Walk one node: its own default caption, then each child's framed caption
 * ahead of the recursion so a parent's framing beats the child's default.
 */
function collect_captions(node: LayoutNode, captions: Map<string, string>): void {
  if (!captions.has(node.id)) captions.set(node.id, node.kind.toUpperCase())
  const children = node.children ?? []
  for (const [index, child] of children.entries()) {
    const framed = framed_caption(node, child, index)
    if (framed !== null && !captions.has(child.id)) captions.set(child.id, framed)
  }
  for (const child of children) collect_captions(child, captions)
}

/**
 * The caption a combinator stamps on its child, null when the parent kind
 * frames nothing. Map and loop children carry the collapsed combinator name
 * (cardinality is runtime data), a retry child reads the attempt budget, and
 * fallback children are seats: primary on the through line, every later
 * child a backup in a basin (artboards 04 and 06).
 */
function framed_caption(parent: LayoutNode, child: LayoutNode, index: number): string | null {
  switch (parent.kind) {
    case 'map':
      return 'MAP'
    case 'loop':
      return 'LOOP'
    case 'retry':
      return retry_caption(parent.config?.['max_attempts'])
    case 'fallback':
      return `${child.kind.toUpperCase()} · ${index === 0 ? 'PRIMARY' : 'BACKUP'}`
    default:
      return null
  }
}

/**
 * The retry budget when config carries a whole positive count, bare `RETRY`
 * otherwise: a budget the structure does not know is not invented.
 */
function retry_caption(attempts: unknown): string {
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts <= 0) {
    return 'RETRY'
  }
  return `RETRY · ${attempts} ${attempts === 1 ? 'ATTEMPT' : 'ATTEMPTS'}`
}

export type SceneNode = {
  readonly glyph: NodeGlyph
  readonly meta: string
  readonly status: NodeStatus
}

export type SceneJunction = {
  readonly glyph: JunctionGlyph
  readonly label: string
  readonly status: NodeStatus
}

export type SceneGroupLabel = {
  readonly anchor: GroupLabel
  readonly text: string
}

export type Scene = {
  readonly nodes: ReadonlyArray<SceneNode>
  readonly junctions: ReadonlyArray<SceneJunction>
  readonly group_labels: ReadonlyArray<SceneGroupLabel>
}

/**
 * Join laid-out geometry with captions and folded run state. `flow` is
 * expected to be `layout(session.structure)`; the caller keeps the two apart
 * so layout memoizes on structure alone while state changes every event. A
 * glyph the session does not know (the caller broke that contract, or a
 * pre-structure file accreted spans) degrades to its own kind, pending.
 */
export function build_scene(flow: FlowLayout, session: Session): Scene {
  const captions = node_captions(session.structure)
  return {
    nodes: flow.nodes.map((glyph) => ({
      glyph,
      meta: glyph.terminus
        ? 'TERMINUS'
        : (captions.get(glyph.id) ?? glyph.kind.toUpperCase()),
      status: session.state.nodes.get(glyph.id)?.status ?? 'pending',
    })),
    junctions: flow.junctions.map((glyph) => ({
      glyph,
      label: 'merge',
      status: session.state.nodes.get(glyph.owner)?.status ?? 'pending',
    })),
    group_labels: flow.group_labels.map((anchor) => ({
      anchor,
      text: group_text(anchor.owner, session.state.kinds.get(anchor.owner)),
    })),
  }
}

/**
 * A group caption is the combinator's id in the caption register; a fallback
 * appends its readiness, ARMED until a scar reroutes the light (step 12's
 * territory), per artboards 01 and 06.
 */
function group_text(owner: string, kind: string | undefined): string {
  const base = owner.toUpperCase()
  return kind === 'fallback' ? `${base} · ARMED` : base
}
