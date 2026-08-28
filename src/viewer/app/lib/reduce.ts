/**
 * The pure fold that turns a trajectory prefix into canvas state.
 *
 * Everything the canvas draws at time T is `reduce(structure, events[0..t])`
 * (C5): no wall-clock reads, no hidden accumulation, so live mode is replay
 * pinned to the newest event and scrubbing is a refold of the prefix. The
 * incremental form `apply_event` is what live mode calls per frame; the
 * property test in `app_reduce.test.ts` holds the two forms equal at every
 * prefix, which is the purity contract the scrubber and play mode lean on.
 *
 * Runtime joins structure by span meta (D6): a span's `id` field names its
 * `StructureNode`, and repeated same-id spans group as map/loop instances or retry
 * attempts depending on the parent span's kind. The kind comes from the
 * structure tree when the parent joins it, because span `name` is a display
 * name a user can shadow; the wire name is only a fallback for spans the
 * structure does not know.
 *
 * Failure semantics fold two layers (D12). A failed span with an open retry
 * ancestor is absorbed: the run will re-attempt it, so it feeds the header's
 * absorbed count and never scars. Without an absorbing retry, the failure
 * scars the deepest structure-joined span in its chain; the enclosing spans
 * that relay the same error upward stay unscarred so one death is one scar.
 * Engine `turn_retry` events are the second layer: absorbed by definition,
 * counted into the same header stat and marked on their node.
 *
 * Nothing is imported from core, not even types: runtime core code must never
 * reach the compiled bundle (it would drag node builtins into the browser),
 * and the `#core` barrel would pull node-typed modules into the app's
 * DOM-only program. `StructureNode` is the app's structural reading of the
 * `describe.json` FlowNode tree, only the fields the fold joins on; core's
 * type stays assignable to it, which the tests hold by folding the real
 * fixture tree. The wire reading is local and deliberately permissive for the
 * same reason, the stance `sse.ts` set: unknown kinds advance the clock and
 * change nothing else (C7).
 */

/**
 * The slice of the `flow_structure` tree the fold reads: ids to join spans
 * against and kinds to classify parents (which combinator absorbs, which
 * groups instances). Config and metadata stay untyped surplus for layout.
 */
export type StructureNode = {
  readonly kind: string
  readonly id: string
  readonly children?: ReadonlyArray<StructureNode>
}

export type RunStatus = 'done' | 'failed' | 'aborted' | 'suspended'

export type OccurrenceStatus = 'active' | 'done' | 'failed'

/**
 * One span's lifetime on a node. Occurrences accumulate in start order and
 * keep their `parent_span_id`, which is what lets later steps group them per
 * parent (instance ticks under one map span, attempts under one retry span)
 * without re-deriving the join.
 */
export type SpanOccurrence = {
  readonly span_id: string
  readonly parent_span_id: string | null
  readonly status: OccurrenceStatus
  readonly started_ts: number | null
  readonly ended_ts: number | null
  readonly error: string | null
}

export type NodeStatus = 'pending' | 'active' | 'done' | 'failed' | 'suspended'

/**
 * Everything the run has taught us about one structure node. `status` is the
 * puck-level rollup; `occurrences` carries the per-span detail (instance
 * slots, attempt history, failure timestamps) that ticks, loops, and the
 * scrubber's failure marks read directly.
 */
export type NodeRuntime = {
  readonly status: NodeStatus
  readonly occurrences: ReadonlyArray<SpanOccurrence>
  readonly scarred: boolean
  readonly suspended: boolean
  readonly turn_retries: number
  readonly cost_usd: number
}

/**
 * The span registry entry behind the joins: cost and turn_retry attribution
 * walk `parent_span_id` chains to the nearest structure-joined ancestor, and
 * the two failure flags are how a scar lands exactly once. `failed_descendant`
 * makes a span a relay for the absorbed count; `failed_joined_descendant`
 * makes it a relay for scar placement, which differ because engine spans fail
 * below the node that should wear the scar.
 */
export type SpanInfo = {
  readonly name: string
  readonly node_id: string | null
  readonly parent_span_id: string | null
  readonly open: boolean
  readonly failed_descendant: boolean
  readonly failed_joined_descendant: boolean
}

export type CanvasState = {
  readonly run_id: string | null
  readonly run_status: RunStatus | null
  readonly t0_ts: number | null
  readonly last_ts: number | null
  readonly retries_absorbed: number
  readonly scars: number
  readonly cost_usd: number
  readonly unattributed_usd: number
  readonly nodes: ReadonlyMap<string, NodeRuntime>
  readonly spans: ReadonlyMap<string, SpanInfo>
  readonly open_spans: ReadonlyArray<string>
  readonly kinds: ReadonlyMap<string, string>
}

type EventRecord = Readonly<Record<string, unknown>>

const EMPTY_NODE: NodeRuntime = {
  status: 'pending',
  occurrences: [],
  scarred: false,
  suspended: false,
  turn_retries: 0,
  cost_usd: 0,
}

/**
 * The state before any event: every structure node pre-seeded as pending, so
 * the T+0 scaffold draws the whole composition from the first event alone,
 * and the kind index that D6 classification joins against. `null` structure
 * still folds (a pre-structure file must not crash the canvas, C7); nodes
 * then accrete from span meta as spans arrive.
 */
export function initial_state(structure: StructureNode | null): CanvasState {
  const kinds = new Map<string, string>()
  const nodes = new Map<string, NodeRuntime>()
  if (structure !== null) collect(structure, kinds, nodes)
  return {
    run_id: null,
    run_status: null,
    t0_ts: null,
    last_ts: null,
    retries_absorbed: 0,
    scars: 0,
    cost_usd: 0,
    unattributed_usd: 0,
    nodes,
    spans: new Map(),
    open_spans: [],
    kinds,
  }
}

/**
 * Walk the structure tree into the kind index and the pending node map. First
 * id wins: a `<cycle>` back-reference or a shared (diamond) step repeats an
 * id already seen, and both must keep joining the node that owns it.
 */
function collect(
  node: StructureNode,
  kinds: Map<string, string>,
  nodes: Map<string, NodeRuntime>,
): void {
  if (!kinds.has(node.id)) {
    kinds.set(node.id, node.kind)
    nodes.set(node.id, EMPTY_NODE)
  }
  for (const child of node.children ?? []) collect(child, kinds, nodes)
}

/**
 * Fold a whole event prefix. Equal by construction to applying each event in
 * turn, which is exactly what the property test pins.
 */
export function reduce(
  structure: StructureNode | null,
  events: ReadonlyArray<unknown>,
): CanvasState {
  let state = initial_state(structure)
  for (const event of events) state = apply_event(state, event)
  return state
}

/**
 * The fold's elapsed clock: newest event time minus first event time. This is
 * the honest T+ of the folded prefix; a scrub playhead between events shows
 * its own position instead, which is a renderer choice, not state.
 */
export function t_plus_ms(state: CanvasState): number {
  if (state.t0_ts === null || state.last_ts === null) return 0
  return Math.max(0, state.last_ts - state.t0_ts)
}

/**
 * Apply one wire value to the state, returning a new state and never mutating
 * the old one, so retained snapshots stay valid under structural sharing. A
 * value that is not an event at all returns the same reference.
 */
export function apply_event(state: CanvasState, value: unknown): CanvasState {
  if (!is_event(value)) return state
  const event = value

  const ts = num(event, 'ts')
  const next: CanvasState = {
    ...state,
    run_id: state.run_id ?? str(event, 'run_id'),
    t0_ts: state.t0_ts ?? ts,
    last_ts: ts ?? state.last_ts,
  }

  switch (event['kind']) {
    case 'span_start':
      return on_span_start(next, event, ts)
    case 'span_end':
      return on_span_end(next, event, ts)
    case 'suspended':
      return on_suspended(next, event)
    case 'turn_retry':
      return on_turn_retry(next, event)
    case 'cost':
      return on_cost(next, event)
    case 'run_end':
      return on_run_end(next, event)
    default:
      return next
  }
}

/** The wire gate, locally: a non-array object carrying a string `kind`. */
function is_event(value: unknown): value is EventRecord {
  if (typeof value !== 'object' || value === null) return false
  if (Array.isArray(value)) return false
  return typeof (value as { kind?: unknown }).kind === 'string'
}

/** Read a string field off a wire event, null when absent or another type. */
function str(event: EventRecord, key: string): string | null {
  const field = event[key]
  return typeof field === 'string' ? field : null
}

/** Read a finite number field off a wire event, null when absent or unusable. */
function num(event: EventRecord, key: string): number | null {
  const field = event[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : null
}

/**
 * A span opens: register it, push the open stack, and when it joins a node,
 * append an active occurrence there. A new occurrence also lifts suspension,
 * because any fresh activity on a parked node means the light moved again.
 */
function on_span_start(
  state: CanvasState,
  event: EventRecord,
  ts: number | null,
): CanvasState {
  const span_id = str(event, 'span_id')
  const name = str(event, 'name')
  if (span_id === null || name === null) return state
  const parent_span_id = str(event, 'parent_span_id')
  const node_id = str(event, 'id')

  const spans = new Map(state.spans)
  spans.set(span_id, {
    name,
    node_id,
    parent_span_id,
    open: true,
    failed_descendant: false,
    failed_joined_descendant: false,
  })
  const opened: CanvasState = {
    ...state,
    spans,
    open_spans: [...state.open_spans, span_id],
  }
  if (node_id === null) return opened

  const node = state.nodes.get(node_id) ?? EMPTY_NODE
  const occurrence: SpanOccurrence = {
    span_id,
    parent_span_id,
    status: 'active',
    started_ts: ts,
    ended_ts: null,
    error: null,
  }
  const nodes = new Map(state.nodes)
  nodes.set(
    node_id,
    with_status({
      ...node,
      occurrences: [...node.occurrences, occurrence],
      suspended: false,
    }),
  )
  return { ...opened, nodes }
}

/**
 * A span closes: settle its occurrence, then fold the failure semantics. On
 * an error close, the failure flags propagate one level up so ancestors know
 * they are relays, the absorbed counter takes origin failures under an open
 * retry, the scar lands on the deepest joined span otherwise, and a retry
 * that exhausts converts its final absorbed attempt into the scar it turned
 * out to be.
 */
function on_span_end(
  state: CanvasState,
  event: EventRecord,
  ts: number | null,
): CanvasState {
  const span_id = str(event, 'span_id')
  if (span_id === null) return state
  const span = state.spans.get(span_id)
  if (span === undefined || !span.open) return state

  const failed = event['error'] !== undefined
  const next = close_span(state, span_id, span, failed)
  const nodes = new Map(next.nodes)

  let updated = settled_node(next, span_id, span, failed, ts, str(event, 'error'))
  let counters: FailureCounters = {
    scars: next.scars,
    retries_absorbed: next.retries_absorbed,
  }
  if (failed) {
    const fold = fold_failure(next, span, updated, counters)
    updated = fold.node
    counters = { scars: fold.scars, retries_absorbed: fold.retries_absorbed }
  }
  if (updated !== undefined && span.node_id !== null) {
    nodes.set(span.node_id, with_status(updated))
  }
  if (failed) {
    counters = convert_exhausted_retry(next, span_id, span, nodes, counters)
  }
  return { ...next, nodes, ...counters }
}

type FailureCounters = {
  readonly scars: number
  readonly retries_absorbed: number
}

/**
 * Close a span's registry entry, pop it off the open stack, and on failure
 * hand the two relay flags one level up, which is how ancestors learn they
 * are relaying this error rather than originating their own.
 */
function close_span(
  state: CanvasState,
  span_id: string,
  span: SpanInfo,
  failed: boolean,
): CanvasState {
  const spans = new Map(state.spans)
  spans.set(span_id, { ...span, open: false })
  if (failed && span.parent_span_id !== null) {
    const parent = spans.get(span.parent_span_id)
    if (parent !== undefined) {
      spans.set(span.parent_span_id, {
        ...parent,
        failed_descendant: true,
        failed_joined_descendant:
          parent.failed_joined_descendant ||
          span.node_id !== null ||
          span.failed_joined_descendant,
      })
    }
  }
  return {
    ...state,
    spans,
    open_spans: state.open_spans.filter((id) => id !== span_id),
  }
}

/**
 * Settle the closing span's occurrence on its node: the active entry becomes
 * done or failed with its end time and error. Undefined when the span joins
 * no node, which is every engine span.
 */
function settled_node(
  state: CanvasState,
  span_id: string,
  span: SpanInfo,
  failed: boolean,
  ts: number | null,
  error: string | null,
): NodeRuntime | undefined {
  if (span.node_id === null) return undefined
  const node = state.nodes.get(span.node_id)
  if (node === undefined) return undefined
  const status: OccurrenceStatus = failed ? 'failed' : 'done'
  return {
    ...node,
    occurrences: node.occurrences.map((occurrence) =>
      occurrence.span_id === span_id
        ? { ...occurrence, status, ended_ts: ts, error }
        : occurrence,
    ),
  }
}

/**
 * The absorb-or-scar decision for one failed close. An open retry ancestor
 * absorbs the failure into the header count, once, at the origin; without one
 * the scar lands here if this span is the deepest joined link in the failure
 * chain. A suspended node did not fail, it parked, so neither counter moves.
 */
function fold_failure(
  state: CanvasState,
  span: SpanInfo,
  node: NodeRuntime | undefined,
  counters: FailureCounters,
): FailureCounters & { readonly node: NodeRuntime | undefined } {
  if (node?.suspended === true) return { ...counters, node }
  if (absorbed_by_retry(state, span)) {
    const bump = span.failed_descendant ? 0 : 1
    return { ...counters, retries_absorbed: counters.retries_absorbed + bump, node }
  }
  if (node === undefined || span.failed_joined_descendant || node.scarred) {
    return { ...counters, node }
  }
  return { ...counters, scars: counters.scars + 1, node: { ...node, scarred: true } }
}

/**
 * When a retry combinator itself dies without a further absorber, its final
 * failed attempt turns out to have been terminal: move that one count from
 * absorbed to a scar on the attempt's node.
 */
function convert_exhausted_retry(
  state: CanvasState,
  span_id: string,
  span: SpanInfo,
  nodes: Map<string, NodeRuntime>,
  counters: FailureCounters,
): FailureCounters {
  if (span_kind(state, span) !== 'retry') return counters
  if (absorbed_by_retry(state, span)) return counters
  const victim = exhausted_attempt(nodes, span_id)
  if (victim === null || victim.node.scarred) return counters
  nodes.set(victim.id, { ...victim.node, scarred: true })
  return {
    scars: counters.scars + 1,
    retries_absorbed: Math.max(0, counters.retries_absorbed - 1),
  }
}

/**
 * The suspend step recorded its pause before throwing, so the node parks as
 * suspended ahead of the error close that follows; the suspended flag is what
 * keeps that close from counting as a scar.
 */
function on_suspended(state: CanvasState, event: EventRecord): CanvasState {
  const step_id = str(event, 'step_id')
  if (step_id === null) return state
  const node = state.nodes.get(step_id) ?? EMPTY_NODE
  const nodes = new Map(state.nodes)
  nodes.set(step_id, with_status({ ...node, suspended: true }))
  return { ...state, nodes }
}

/**
 * An engine-absorbed provider retry: always feeds the header count (D12), and
 * marks the node it attributes to so step 11 can draw the per-node tick.
 */
function on_turn_retry(state: CanvasState, event: EventRecord): CanvasState {
  const retries_absorbed = state.retries_absorbed + 1
  const node_id = attributed_node(state, str(event, 'span_id'))
  if (node_id === null) return { ...state, retries_absorbed }
  const node = state.nodes.get(node_id) ?? EMPTY_NODE
  const nodes = new Map(state.nodes)
  nodes.set(node_id, { ...node, turn_retries: node.turn_retries + 1 })
  return { ...state, retries_absorbed, nodes }
}

/**
 * Cost rolls into the run total unconditionally and onto a node when one can
 * be named: exactly via the event's `span_id` (E), else the open-stack
 * heuristic for pre-E files, else the legible unattributed bucket.
 */
function on_cost(state: CanvasState, event: EventRecord): CanvasState {
  const total = num(event, 'total_usd')
  if (total === null) return state
  const cost_usd = state.cost_usd + total
  const node_id = attributed_node(state, str(event, 'span_id'))
  if (node_id === null) {
    return { ...state, cost_usd, unattributed_usd: state.unattributed_usd + total }
  }
  const node = state.nodes.get(node_id) ?? EMPTY_NODE
  const nodes = new Map(state.nodes)
  nodes.set(node_id, { ...node, cost_usd: node.cost_usd + total })
  return { ...state, cost_usd, nodes }
}

/** Narrow a wire status string to the known run outcomes, without a cast. */
function is_run_end_status(value: string): value is RunStatus {
  return (
    value === 'done' || value === 'failed' || value === 'aborted' || value === 'suspended'
  )
}

/** The terminal event resolves the run's outcome; unknown statuses stay inert. */
function on_run_end(state: CanvasState, event: EventRecord): CanvasState {
  const status = str(event, 'status')
  if (status === null || !is_run_end_status(status)) return state
  return { ...state, run_status: status }
}

/** Recompute the puck-level rollup after any occurrence or flag change. */
function with_status(node: NodeRuntime): NodeRuntime {
  return { ...node, status: node_status(node) }
}

/**
 * Suspension overrides everything (the light is parked, not gone), any live
 * occurrence means active, and otherwise the newest occurrence speaks for the
 * node: a retry that eventually succeeded reads done, not failed.
 */
function node_status(node: NodeRuntime): NodeStatus {
  if (node.suspended) return 'suspended'
  if (node.occurrences.some((occurrence) => occurrence.status === 'active')) {
    return 'active'
  }
  const last = node.occurrences[node.occurrences.length - 1]
  if (last === undefined) return 'pending'
  return last.status === 'failed' ? 'failed' : 'done'
}

/**
 * Resolve a span's combinator kind: the structure tree's kind when the span
 * joins a node (authoritative, since span names are display names a user can
 * shadow), the wire name otherwise.
 */
function span_kind(state: CanvasState, span: SpanInfo): string {
  if (span.node_id !== null) {
    const kind = state.kinds.get(span.node_id)
    if (kind !== undefined) return kind
  }
  return span.name
}

/**
 * True when a still-open ancestor is a retry combinator: the failure just
 * recorded will be caught and re-attempted, so it is absorbed rather than
 * permanent. Closed ancestors cannot re-attempt and do not count. The hop cap
 * keeps a malformed parent cycle from hanging the fold (C7).
 */
function absorbed_by_retry(state: CanvasState, span: SpanInfo): boolean {
  let hops = state.spans.size + 1
  let parent_id = span.parent_span_id
  while (parent_id !== null && hops > 0) {
    hops -= 1
    const parent = state.spans.get(parent_id)
    if (parent === undefined) return false
    if (parent.open && span_kind(state, parent) === 'retry') return true
    parent_id = parent.parent_span_id
  }
  return false
}

/**
 * The node an unanchored event lands on: the event's own span when it names
 * one (exact attribution, E), else the deepest open span (the pre-E
 * open-stack heuristic), in both cases walked up to the nearest
 * structure-joined ancestor, since engine spans hang below the node that
 * should own the number.
 */
function attributed_node(state: CanvasState, span_id: string | null): string | null {
  const start = span_id ?? state.open_spans[state.open_spans.length - 1] ?? null
  if (start === null) return null
  let hops = state.spans.size + 1
  let current = state.spans.get(start)
  while (current !== undefined && hops > 0) {
    hops -= 1
    if (current.node_id !== null) return current.node_id
    if (current.parent_span_id === null) return null
    current = state.spans.get(current.parent_span_id)
  }
  return null
}

/**
 * Find the node whose newest occurrence is the failed attempt directly under
 * an exhausted retry span. That attempt was counted absorbed when it failed;
 * the retry's own failure is the news that it was terminal after all. Null
 * when the retry died without a failed attempt on record, which leaves the
 * retry span itself as the failure's origin.
 */
function exhausted_attempt(
  nodes: ReadonlyMap<string, NodeRuntime>,
  retry_span_id: string,
): { readonly id: string; readonly node: NodeRuntime } | null {
  for (const [id, node] of nodes) {
    const last = node.occurrences[node.occurrences.length - 1]
    if (last?.status === 'failed' && last.parent_span_id === retry_span_id) {
      return { id, node }
    }
  }
  return null
}
