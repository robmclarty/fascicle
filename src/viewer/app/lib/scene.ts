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
 * structure already knows, and runtime facts join it strictly as they become
 * true. A map child is `MAP` until instances exist, then `MAP ×3 · 31MS`; a
 * retry child reads its attempt budget from config until attempts exist, then
 * `RETRY · ATT 2/3`; a step is `STEP`, then `STEP · RUNNING`, then
 * `STEP · 42MS`.
 *
 * Runtime treatment is the light metaphor made arithmetic. Every drawn
 * segment is unbuilt, live, or traversed, decided by where the fold says the
 * light has been: a segment lights while the leaf it feeds is running and
 * goes grey once that leaf has been entered, a segment that exits a
 * combinator earns its grey only when the combinator closes (the light is
 * still inside until then), and the join legs of a fan belong to the fan's
 * own completion. The retry circle is its own two-lane rule from artboard
 * 01: the upper arc is the live lane, amber while an attempt runs or a
 * re-attempt is owed, and the lower arc is the spent lane, grey with one
 * ember mark per failed attempt. Amber appears nowhere else (C4).
 */

import {
  TOKENS,
  type FlowLayout,
  type GroupLabel,
  type JunctionGlyph,
  type LayoutNode,
  type NodeGlyph,
  type Segment,
} from './layout.js'
import { format_duration } from './format.js'
import {
  apply_event,
  initial_state,
  type CanvasState,
  type NodeStatus,
  type SpanOccurrence,
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
  const budget = whole_count(attempts)
  if (budget === null) return 'RETRY'
  return `RETRY · ${budget} ${budget === 1 ? 'ATTEMPT' : 'ATTEMPTS'}`
}

/**
 * Narrow a config value to a whole positive count, null otherwise. The
 * typeof guard exists for the narrowing; `Number.isInteger` alone would
 * already reject every non-number without coercion.
 */
function whole_count(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
  return value
}

/**
 * A scar's ember ✕: the seat the mark orbits its broken puck, from artboard
 * 04. Null on `SceneNode.scar` for every node the run never scarred.
 */
export type ScarMark = {
  readonly x: number
  readonly y: number
}

export type SceneNode = {
  readonly glyph: NodeGlyph
  readonly meta: string
  readonly status: NodeStatus
  readonly scar: ScarMark | null
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

export type SegmentState = 'unbuilt' | 'live' | 'traversed'

export type SceneSegment = {
  readonly segment: Segment
  readonly state: SegmentState
}

/** One ember ✕ beside a retry circle: a spent attempt's permanent record. */
export type FailMark = {
  readonly x: number
  readonly y: number
}

export type Scene = {
  readonly nodes: ReadonlyArray<SceneNode>
  readonly junctions: ReadonlyArray<SceneJunction>
  readonly group_labels: ReadonlyArray<SceneGroupLabel>
  readonly segments: ReadonlyArray<SceneSegment>
  readonly fail_marks: ReadonlyArray<FailMark>
}

/** The active-puck halo radius, from artboard 01. */
export const HALO_RADIUS = 40

/** The ambient bloom radius around a live point, from artboard 01. */
export const BLOOM_RADIUS = 215

/** A fail mark floats this far off the retry circle's arc (artboard 01). */
const MARK_ORBIT = 14

/** Newest mark at the artboard's southeast seat; older ones step onward. */
const MARK_ANGLE = Math.PI / 4

/** The scar ✕'s seat off its broken puck: up and to the east (artboard 04). */
const SCAR_MARK_DX = 14
const SCAR_MARK_DY = -17

/**
 * The structural lookups one scene build reads over and over: who owns each
 * junction, who is whose parent, which leaf a box's inbound segment actually
 * feeds, which leaves anchor a retry circle (their re-entries belong to the
 * arcs, never to the spine), and which leaves are a fallback's primary (their
 * through-line dies when they scar, so the light reroutes through the basin).
 * First id wins throughout, matching the fold's join for `<cycle>`
 * back-references and shared steps.
 */
type SceneContext = {
  readonly state: CanvasState
  readonly parents: ReadonlyMap<string, string>
  readonly nodes_by_id: ReadonlyMap<string, LayoutNode>
  readonly first_leaves: ReadonlyMap<string, string>
  readonly junction_owners: ReadonlyMap<string, string>
  readonly loop_leaves: ReadonlySet<string>
  readonly fallback_primaries: ReadonlySet<string>
}

/**
 * Join laid-out geometry with captions and folded run state. `flow` is
 * expected to be `layout(session.structure)`; the caller keeps the two apart
 * so layout memoizes on structure alone while state changes every event. A
 * glyph the session does not know (the caller broke that contract, or a
 * pre-structure file accreted spans) degrades to its own kind, pending.
 */
export function build_scene(flow: FlowLayout, session: Session): Scene {
  const ctx = scene_context(flow, session)
  const captions = node_captions(session.structure)
  return {
    nodes: flow.nodes.map((glyph) => ({
      glyph,
      meta: node_meta(ctx, glyph, captions),
      status: view_status(ctx, glyph.id),
      scar: node_scar(session.state, glyph),
    })),
    junctions: flow.junctions.map((glyph) => ({
      glyph,
      label: 'merge',
      status: session.state.nodes.get(glyph.owner)?.status ?? 'pending',
    })),
    group_labels: flow.group_labels.map((anchor) => ({
      anchor,
      text: group_text(ctx, anchor.owner),
    })),
    segments: flow.segments.map((segment) => ({
      segment,
      state: segment_state(ctx, segment),
    })),
    fail_marks: fail_marks(flow, session.state),
  }
}

/** Build the lookup bundle for one scene: structure walked once, flow scanned once. */
function scene_context(flow: FlowLayout, session: Session): SceneContext {
  const parents = new Map<string, string>()
  const nodes_by_id = new Map<string, LayoutNode>()
  const first_leaves = new Map<string, string>()
  if (session.structure !== null) {
    index_structure(session.structure, parents, nodes_by_id, first_leaves)
  }
  const junction_owners = new Map<string, string>()
  for (const junction of flow.junctions) junction_owners.set(junction.id, junction.owner)
  const loop_leaves = new Set<string>()
  for (const segment of flow.segments) {
    if (segment.role === 'loop_upper') loop_leaves.add(segment.to)
  }
  const fallback_primaries = new Set<string>()
  for (const node of nodes_by_id.values()) {
    if (node.kind !== 'fallback') continue
    const primary = node.children?.[0]
    if (primary !== undefined) fallback_primaries.add(primary.id)
  }
  return {
    state: session.state,
    parents,
    nodes_by_id,
    first_leaves,
    junction_owners,
    loop_leaves,
    fallback_primaries,
  }
}

/**
 * Walk the tree into the parent, node, and first-leaf indexes. The first
 * leaf is what a box's inbound segment visually touches, because every
 * geometry family places its first child at its own west edge.
 */
function index_structure(
  node: LayoutNode,
  parents: Map<string, string>,
  nodes_by_id: Map<string, LayoutNode>,
  first_leaves: Map<string, string>,
): void {
  if (!nodes_by_id.has(node.id)) {
    nodes_by_id.set(node.id, node)
    first_leaves.set(node.id, first_leaf(node))
  }
  for (const child of node.children ?? []) {
    if (!parents.has(child.id)) parents.set(child.id, node.id)
    index_structure(child, parents, nodes_by_id, first_leaves)
  }
}

/** Descend first children to the leaf a subtree's west edge places. */
function first_leaf(node: LayoutNode): string {
  let current = node
  while (current.children !== undefined && current.children.length > 0) {
    const head = current.children[0]
    if (head === undefined) break
    current = head
  }
  return current.id
}

/** A node's span history, empty for one the fold has never seen. */
function occurrences_of(
  state: CanvasState,
  id: string,
): ReadonlyArray<SpanOccurrence> {
  return state.nodes.get(id)?.occurrences ?? []
}

/** True while any of the node's spans is still open. */
function is_running(occurrences: ReadonlyArray<SpanOccurrence>): boolean {
  return occurrences.some((occurrence) => occurrence.status === 'active')
}

/** True once the node has run and nothing on it is still open. */
function completed(state: CanvasState, id: string): boolean {
  const occurrences = occurrences_of(state, id)
  return occurrences.length > 0 && !is_running(occurrences)
}

/**
 * Where one drawn segment sits in the light's story. The retry lanes rule
 * themselves; a fan's join legs belong to the fan's completion (the light
 * pops out of the junction when the fan closes); a segment leaving its own
 * subtree earns grey only when that subtree's combinator closes; and every
 * other segment defers to `leaf_segment_state`, which follows the leaf it
 * feeds. The approach into a fallback greys through that path because it
 * feeds the wrapper, not the scarred primary, so the light is shown reaching
 * the scar before it reroutes through the basin.
 */
function segment_state(ctx: SceneContext, segment: Segment): SegmentState {
  switch (segment.role) {
    case 'loop_upper':
      return live_lane_state(ctx.state, segment.from ?? segment.to, segment.to)
    case 'loop_lower':
      return spent_lane_state(ctx.state, segment.to)
    case 'loop_return':
      return return_lane_state(ctx, segment.to)
    default:
      break
  }
  const owner = ctx.junction_owners.get(segment.to)
  if (owner !== undefined) {
    return completed(ctx.state, owner) ? 'traversed' : 'unbuilt'
  }
  if (segment.from !== null && inside(ctx.parents, segment.from, segment.to)) {
    return completed(ctx.state, segment.to) ? 'traversed' : 'unbuilt'
  }
  return leaf_segment_state(ctx, segment)
}

/**
 * A plain segment's state from the leaf it feeds: unbuilt until the leaf is
 * entered, live while it runs, traversed after. Two exceptions ride here: a
 * retry circle's anchor leaf settles its spine to grey at once because the
 * re-entries belong to the arcs, and a scarred fallback primary's through-line
 * is the dead segment past the scar, so it stays unbuilt while the light
 * reroutes through the basin.
 */
function leaf_segment_state(ctx: SceneContext, segment: Segment): SegmentState {
  if (ctx.fallback_primaries.has(segment.to) && is_scarred(ctx.state, segment.to)) {
    return 'unbuilt'
  }
  const target = ctx.first_leaves.get(segment.to) ?? segment.to
  const occurrences = occurrences_of(ctx.state, target)
  if (occurrences.length === 0) return 'unbuilt'
  if (is_running(occurrences) && !ctx.loop_leaves.has(target)) return 'live'
  return 'traversed'
}

/** True once the run has hung a permanent scar on a node (the fold's record). */
function is_scarred(state: CanvasState, id: string): boolean {
  return state.nodes.get(id)?.scarred === true
}

/**
 * True when `from` sits inside `to`'s subtree, walked on the parent chain.
 * The hop cap guards a malformed shared-id chain that loops (C7).
 */
function inside(parents: ReadonlyMap<string, string>, from: string, to: string): boolean {
  let hops = parents.size + 1
  let current: string | undefined = from
  while (current !== undefined && hops > 0) {
    hops -= 1
    if (current === to) return true
    current = parents.get(current)
  }
  return false
}

/**
 * The upper arc, artboard 01's live lane: amber while the loop carries
 * light, grey once any attempt has run, dashes until the first one does.
 */
function live_lane_state(state: CanvasState, loop_id: string, leaf_id: string): SegmentState {
  const attempts = occurrences_of(state, leaf_id)
  if (loop_engaged(state, loop_id, attempts)) return 'live'
  return attempts.length > 0 ? 'traversed' : 'unbuilt'
}

/** The lower arc, the spent lane: grey wreckage once any attempt has failed. */
function spent_lane_state(state: CanvasState, leaf_id: string): SegmentState {
  const failed = occurrences_of(state, leaf_id).some(
    (occurrence) => occurrence.status === 'failed',
  )
  return failed ? 'traversed' : 'unbuilt'
}

/**
 * True while the loop is carrying light: an attempt runs right now, or the
 * last one failed and the still-open combinator owes another (the backoff
 * pause is part of the next attempt, which is how artboard 01 reads
 * `ATT 2/3` between spans).
 */
function loop_engaged(
  state: CanvasState,
  loop_id: string,
  attempts: ReadonlyArray<SpanOccurrence>,
): boolean {
  if (!is_running(occurrences_of(state, loop_id))) return false
  if (is_running(attempts)) return true
  return attempts[attempts.length - 1]?.status === 'failed'
}

/**
 * A wide loop's return line: the repeat's own path. The first pass traverses
 * the subtree itself, so the line lights only when a repeat runs or is owed,
 * and earns grey only once a repeat actually happened.
 */
function return_lane_state(ctx: SceneContext, loop_id: string): SegmentState {
  const body = ctx.nodes_by_id.get(loop_id)?.children?.[0]
  if (body === undefined) return 'unbuilt'
  const attempts = occurrences_of(ctx.state, body.id)
  const repeated = attempts.length >= 2
  if (loop_engaged(ctx.state, loop_id, attempts) && (repeated || !is_running(attempts))) {
    return 'live'
  }
  return repeated ? 'traversed' : 'unbuilt'
}

/**
 * One ember ✕ per failed attempt on each retry circle, orbiting outside the
 * spent arc. The newest sits at the artboard's southeast seat; older marks
 * step onward around the circle and hold the last seat past three, since a
 * real budget never reaches it.
 */
function fail_marks(flow: FlowLayout, state: CanvasState): ReadonlyArray<FailMark> {
  const marks: FailMark[] = []
  for (const segment of flow.segments) {
    if (segment.role !== 'loop_lower') continue
    const glyph = flow.nodes.find((node) => node.id === segment.to)
    if (glyph === undefined) continue
    const failures = occurrences_of(state, segment.to).filter(
      (occurrence) => occurrence.status === 'failed',
    ).length
    const center_x = glyph.center.x + TOKENS.loop_radius
    const orbit = TOKENS.loop_radius + MARK_ORBIT
    for (let index = 0; index < failures; index += 1) {
      const age = Math.min(failures - 1 - index, 2)
      const angle = MARK_ANGLE + age * MARK_ANGLE
      marks.push({
        x: center_x + Math.cos(angle) * orbit,
        y: glyph.center.y + Math.sin(angle) * orbit,
      })
    }
  }
  return marks
}

/**
 * A scarred node's ember ✕, seated off its broken puck (artboard 04), null
 * for every node the run never scarred. The scar reads off the fold's
 * permanent `scarred` record rather than the puck status, because a retry
 * that eventually healed reads `done` while a fallback's dead primary keeps
 * its scar; the two must not share a status.
 */
function node_scar(state: CanvasState, glyph: NodeGlyph): ScarMark | null {
  if (state.nodes.get(glyph.id)?.scarred !== true) return null
  return { x: glyph.center.x + SCAR_MARK_DX, y: glyph.center.y + SCAR_MARK_DY }
}

/**
 * The puck-level status a treatment keys off. One reading differs from the
 * fold's: a failed attempt whose retry is still open is about to run again,
 * so the light stays parked on the puck (artboard 01's halo during the
 * backoff pause) instead of flashing failed between spans.
 */
function view_status(ctx: SceneContext, id: string): NodeStatus {
  const status = ctx.state.nodes.get(id)?.status ?? 'pending'
  if (status !== 'failed') return status
  const retry = attempt_parent(ctx, id)
  if (retry !== null && is_running(occurrences_of(ctx.state, retry.id))) return 'active'
  return status
}

/** The retry combinator directly framing a node, null for everyone else. */
function attempt_parent(ctx: SceneContext, id: string): LayoutNode | null {
  const parent_id = ctx.parents.get(id)
  if (parent_id === undefined) return null
  const parent = ctx.nodes_by_id.get(parent_id)
  return parent?.kind === 'retry' ? parent : null
}

/**
 * A node's meta line: the structural caption, joined by what the run has
 * made true. Cardinality accretes as instances exist (D6), `RUNNING` while
 * any span is open, and the group's span once everything ended, so
 * `MAP` becomes `MAP ×3 · 31MS` and `STEP` becomes `STEP · 42MS`. A retry
 * child trades the caption for the attempt ledger instead.
 */
function node_meta(
  ctx: SceneContext,
  glyph: NodeGlyph,
  captions: ReadonlyMap<string, string>,
): string {
  const caption = glyph.terminus
    ? 'TERMINUS'
    : (captions.get(glyph.id) ?? glyph.kind.toUpperCase())
  const occurrences = occurrences_of(ctx.state, glyph.id)
  if (occurrences.length === 0) return caption
  const retry = glyph.terminus ? null : attempt_parent(ctx, glyph.id)
  if (retry !== null) return attempt_meta(ctx.state, retry, occurrences)
  const base =
    occurrences.length >= 2 ? `${caption} ×${occurrences.length}` : caption
  if (is_running(occurrences)) return `${base} · RUNNING`
  return with_span(base, occurrences)
}

/**
 * The attempt ledger, artboard 01's `RETRY · ATT 2/3`: the attempt the loop
 * is on (a failed last attempt under an open retry means the next one is
 * already owed), over the configured budget when the structure knows it,
 * with the loop's whole span appended once it settles.
 */
function attempt_meta(
  state: CanvasState,
  retry: LayoutNode,
  occurrences: ReadonlyArray<SpanOccurrence>,
): string {
  const last = occurrences[occurrences.length - 1]
  const owed =
    last?.status === 'failed' && is_running(occurrences_of(state, retry.id))
  const budget = whole_count(retry.config?.['max_attempts'])
  const seen = occurrences.length + (owed ? 1 : 0)
  const current = budget === null ? seen : Math.min(seen, budget)
  const base = `RETRY · ATT ${current}${budget === null ? '' : `/${budget}`}`
  if (is_running(occurrences) || owed) return base
  return with_span(base, occurrences)
}

/** Append the group's span when its timestamps can actually name one. */
function with_span(base: string, occurrences: ReadonlyArray<SpanOccurrence>): string {
  const span = group_span(occurrences)
  return span === null ? base : `${base} · ${format_duration(span)}`
}

/**
 * A group's wall span: first start to last end, the number artboard 01
 * prints for a settled map (`31MS` spans all three instances). Null when a
 * permissive parse left either end unknown.
 */
function group_span(occurrences: ReadonlyArray<SpanOccurrence>): number | null {
  let first: number | null = null
  let last: number | null = null
  for (const occurrence of occurrences) {
    if (occurrence.started_ts !== null && (first === null || occurrence.started_ts < first)) {
      first = occurrence.started_ts
    }
    if (occurrence.ended_ts !== null && (last === null || occurrence.ended_ts > last)) {
      last = occurrence.ended_ts
    }
  }
  return first === null || last === null ? null : Math.max(0, last - first)
}

/**
 * A group caption is the combinator's id in the caption register, wearing
 * its span once it settles (artboard 01's `PARALLEL_1 · 45MS`). A fallback
 * appends its readiness until then: ARMED, waiting, per artboards 01 and
 * 06; the scar reroute that changes it is step 12's territory.
 */
function group_text(ctx: SceneContext, owner: string): string {
  const base = owner.toUpperCase()
  const armed = ctx.state.kinds.get(owner) === 'fallback' ? ' · ARMED' : ''
  const occurrences = occurrences_of(ctx.state, owner)
  if (occurrences.length === 0 || is_running(occurrences)) return `${base}${armed}`
  const span = group_span(occurrences)
  return span === null ? `${base}${armed}` : `${base} · ${format_duration(span)}`
}
