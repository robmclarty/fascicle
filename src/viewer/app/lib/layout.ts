/**
 * Metro-line layout: the pure geometry of a flow's composition.
 *
 * `layout(structure)` maps the `flow_structure` tree to the run canvas's
 * drawn geometry. It reads structure alone, never run state, which is the
 * T+0 honesty rule made structural: positions cannot differ across run
 * states because no run state ever reaches this module. The renderer paints
 * runtime treatment (dashed scaffold, traversed grey, live amber) onto
 * geometry that was settled at the first event.
 *
 * Every kind in the step registry maps to one of five geometry families:
 *
 * - spine: leaves are pucks on the line (`step`, `suspend`, `use`) and the
 *   sequential wrappers lay their children along it (`sequence`, `pipe`,
 *   `chain`, `compose`, `checkpoint`, `stash`, `scope`, `timeout`).
 * - fan: `parallel` and `branch` split into lanes that rejoin at a junction
 *   puck; the four composite kinds (`adversarial`, `ensemble`, `tournament`,
 *   `consensus`) run several members, so they read as fans too.
 * - loop: `retry` and `loop` around a single puck draw the artboard's
 *   circle in the line; around anything wider they draw a return line
 *   routed below, because attempts over a subtree traverse the subtree's
 *   own geometry and only the repeat needs a path of its own.
 * - basin: `fallback` keeps its primary on the through line and routes each
 *   backup through a bypass basin below.
 * - tick lane: `map` collapses its instances onto one child (D6) and
 *   reserves a stretch of outgoing line where instance ticks accrete.
 *
 * Unknown kinds render harmlessly (C7): with children they lay out as a
 * sequence, without they are a puck, and a `<cycle>` back-reference is a
 * puck that shares its target's id so the renderer lights both together.
 *
 * The numbers come from the frozen artboards. Tokens named by the design
 * system (margin 72, branch pitch 92, corner radius 24, label clearance 16,
 * tick pitches 30/18 with decade gaps) are carried verbatim; the remaining
 * constants (node pitch 128, lane lead 56, junction gap 36, entry stub 28,
 * basin shoulder 108, tick reserve 160) are measured off artboards 01 and
 * 04 so the fixture flow reproduces their proportions. `TOKENS` is exported
 * as one frozen bag because it is the contract the tests pin.
 *
 * Overflow follows the Q3 ruling: `fit_viewport` scales the whole canvas to
 * fit, never above 1, and stops at `MIN_SCALE` (rendered Sora names must
 * stay at or above 11px of their 15px set size); past the floor the fit
 * reports pan instead. Label collision at fixed scale falls back to
 * truncation with a title, which is the renderer's job: the pitch a name
 * must fit inside is `TOKENS.node_pitch` less clearance.
 *
 * Nothing is imported, not even the fold's types: the module is a leaf the
 * bundler, the mutation gate, and the tests can hold in isolation.
 * `LayoutNode` is this module's structural reading of the same
 * `describe.json` tree the fold reads; core's `FlowNode` and the fold's
 * `StructureNode` both stay assignable to it.
 */

/**
 * The slice of the `flow_structure` tree layout reads: kinds to pick a
 * geometry family, ids to key glyphs, children to recurse, and `config`
 * only for the optional `display_name` a user may have set.
 */
export type LayoutNode = {
  readonly kind: string
  readonly id: string
  readonly config?: Readonly<Record<string, unknown>>
  readonly children?: ReadonlyArray<LayoutNode>
}

export type Point = { readonly x: number; readonly y: number }

/**
 * One puck and its two text baselines. `name_anchor` sits `name_drop` below
 * the node's local geometry (the line, or the loop's lower arc when the
 * puck anchors a retry circle), `meta_anchor` a further `meta_drop` down.
 * The terminus puck (the flow's final glyph) carries the outer-ring flag.
 */
export type NodeGlyph = {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly center: Point
  readonly radius: number
  readonly terminus: boolean
  readonly name_anchor: Point
  readonly meta_anchor: Point
}

/**
 * The small puck where a fan's lanes rejoin (artboard 01's `merge`). It is
 * synthetic geometry, not a structure node, so it carries its own id
 * (`<fan id>:junction`) plus the owning fan's id for runtime treatment.
 */
export type JunctionGlyph = {
  readonly id: string
  readonly owner: string
  readonly center: Point
  readonly radius: number
  readonly label_anchor: Point
}

export type SegmentRole =
  | 'entry'
  | 'line'
  | 'branch_in'
  | 'branch_out'
  | 'loop_upper'
  | 'loop_lower'
  | 'loop_return'
  | 'basin'

/**
 * One drawn line. `to` names the structure node whose runtime activity
 * lights the segment; `from` is the node west of it (null only for the
 * entry stub). `path` is ready-to-render SVG path data because the
 * components stay thin (D4): every coordinate decision is made here.
 */
export type Segment = {
  readonly role: SegmentRole
  readonly from: string | null
  readonly to: string
  readonly path: string
}

/**
 * A combinator's quiet caption: the 14px tick dash and the text baseline
 * that starts `group_text_indent` east of it. Text content is the
 * renderer's call; layout owns only the anchors.
 */
export type GroupLabel = {
  readonly owner: string
  readonly tick: Point
  readonly text_anchor: Point
}

/**
 * The stretch of line reserved for a map's instance ticks. Cardinality is
 * runtime data, so the lane is statically sized (T+0 honesty) and
 * `tick_marks` fits however many instances exist into it at render time.
 */
export type TickLane = {
  readonly owner: string
  readonly y: number
  readonly x0: number
  readonly x1: number
}

export type FlowLayout = {
  readonly width: number
  readonly height: number
  readonly spine_y: number
  readonly nodes: ReadonlyArray<NodeGlyph>
  readonly junctions: ReadonlyArray<JunctionGlyph>
  readonly segments: ReadonlyArray<Segment>
  readonly group_labels: ReadonlyArray<GroupLabel>
  readonly tick_lanes: ReadonlyArray<TickLane>
}

/**
 * The spacing system, frozen. The first group is named by artboard 05
 * verbatim; the second is measured off artboards 01, 03, and 04 (node
 * pitch is the spine's dominant puck rhythm, the entry stub is one dot-grid
 * cell, the basin shoulder is the flat approach either side of a fallback's
 * primary). Type sizes ride along because the Q3 scale floor derives from
 * them. Tests pin the whole bag: drift here is a design break, not a tune.
 */
export const TOKENS = {
  margin: 72,
  branch_pitch: 92,
  corner_radius: 24,
  label_clear: 16,
  name_drop: 38,
  meta_drop: 20,
  group_label_rise: 52,
  group_tick_length: 14,
  tick_pitch: 30,
  comb_pitch: 18,
  decade: 10,
  decade_gap: 8,
  node_pitch: 128,
  entry_stub: 28,
  lane_lead: 56,
  junction_gap: 36,
  junction_label_drop: 37,
  loop_radius: 46,
  basin_radius: 32,
  basin_shoulder: 108,
  basin_drop: 92,
  group_text_indent: 22,
  tick_lead: 72,
  tick_reserve: 160,
  puck_radius: 7,
  junction_radius: 5.5,
  terminus_radius: 6.5,
  terminus_ring_radius: 12,
  name_px: 15,
  min_name_px: 11,
} as const

/** Q3's readability floor: a 15px Sora name may shrink to 11px, no further. */
export const MIN_SCALE = TOKENS.min_name_px / TOKENS.name_px

/** Vertical space a puck claims above its line (ring radius plus stroke). */
const PUCK_CLEAR = 10

/** Descender allowance under a text baseline when computing extents. */
const DESCENT = 4

/** Cap height of the 11px mono captions, for extents above a baseline. */
const LABEL_CAP = 11

/** A leaf's extent below its line: name drop, meta drop, meta descender. */
const LABEL_BELOW = TOKENS.name_drop + TOKENS.meta_drop + DESCENT

/** The group-label tick sits this far above its text baseline. */
const GROUP_TICK_RISE = 4

/** A fan's caption extent above its topmost lane line. */
const FAN_LABEL_ABOVE = TOKENS.group_label_rise + LABEL_CAP

/** The loop caption hangs beside the arc: clearance plus cap height. */
const LOOP_LABEL_ABOVE = TOKENS.label_clear + LABEL_CAP

/** The junction caption's extent below the line. */
const JUNCTION_BELOW = TOKENS.junction_label_drop + DESCENT

/** The basin caption's extent below the basin floor (artboard 04). */
const BASIN_LABEL_BELOW = TOKENS.basin_drop + GROUP_TICK_RISE + DESCENT

/** The basin caption's tick starts this far east of the basin mouth. */
const BASIN_LABEL_INDENT = 40

/** A wide loop's return line clears the subtree's labels by this much. */
const LOOP_RETURN_CLEAR = 40

/** Extent the return line itself adds below its floor. */
const LOOP_RETURN_PAD = 8

const FAN_KINDS = new Set([
  'parallel',
  'branch',
  'adversarial',
  'ensemble',
  'tournament',
  'consensus',
])

const LOOP_KINDS = new Set(['retry', 'loop'])

type Sink = {
  readonly nodes: NodeGlyph[]
  readonly junctions: JunctionGlyph[]
  readonly segments: Segment[]
  readonly group_labels: GroupLabel[]
  readonly tick_lanes: TickLane[]
}

/**
 * One measured subtree: extents for composition, `place` to emit glyphs at
 * an absolute position. `label_drop` pushes a leaf's text baselines down
 * (the retry circle hangs its puck's labels below the lower arc).
 * `exit_glyph` is the last through-line puck, kept so the flow's final
 * leaf can be marked as the terminus after placement.
 */
type Box = {
  readonly id: string
  readonly width: number
  readonly above: number
  readonly below: number
  readonly exit_glyph: string | null
  readonly place: (x: number, y: number, sink: Sink, label_drop: number) => void
}

/**
 * Lay out a structure tree. `null` (a pre-structure file, C7) yields an
 * empty canvas of bare margins rather than a crash.
 */
export function layout(root: LayoutNode | null): FlowLayout {
  const sink: Sink = {
    nodes: [],
    junctions: [],
    segments: [],
    group_labels: [],
    tick_lanes: [],
  }
  if (root === null) {
    return {
      width: 2 * TOKENS.margin,
      height: 2 * TOKENS.margin,
      spine_y: TOKENS.margin,
      ...sink,
    }
  }
  const box = measure(root)
  const spine_y = TOKENS.margin + box.above
  const entry_x = TOKENS.margin + TOKENS.entry_stub
  sink.segments.push({
    role: 'entry',
    from: null,
    to: box.id,
    path: `M ${TOKENS.margin} ${spine_y} H ${entry_x}`,
  })
  box.place(entry_x, spine_y, sink, 0)
  mark_terminus(sink, box.exit_glyph)
  return {
    width: entry_x + box.width + TOKENS.margin,
    height: spine_y + box.below + TOKENS.margin,
    spine_y,
    ...sink,
  }
}

/**
 * Pick a subtree's geometry family. Order matters only where shapes
 * overlap: a fan or fallback without enough children degrades to the
 * sequential reading, and any kind without children ends as a puck, which
 * is what keeps foreign kinds harmless (C7).
 */
function measure(node: LayoutNode): Box {
  const children = (node.children ?? []).map(measure)
  if (FAN_KINDS.has(node.kind) && children.length > 0) return fan_box(node, children)
  if (LOOP_KINDS.has(node.kind)) return loop_box(node, children)
  if (node.kind === 'fallback' && children.length >= 2) return basin_box(node, children)
  if (node.kind === 'map') return map_box(node, children)
  if (children.length > 0) return { id: node.id, ...run_box(children) }
  return point_box(node)
}

/** A user-set display name wins over the id, matching core's resolution. */
function display_label(node: LayoutNode): string {
  const name = node.config?.['display_name']
  return typeof name === 'string' && name.length > 0 ? name : node.id
}

/** A leaf: one puck on the line, name and meta baselines below. */
function point_box(node: LayoutNode): Box {
  return {
    id: node.id,
    width: 0,
    above: PUCK_CLEAR,
    below: LABEL_BELOW,
    exit_glyph: node.id,
    place: (x, y, sink, label_drop) => {
      const name_y = y + label_drop + TOKENS.name_drop
      sink.nodes.push({
        id: node.id,
        kind: node.kind,
        label: display_label(node),
        center: { x, y },
        radius: TOKENS.puck_radius,
        terminus: false,
        name_anchor: { x, y: name_y },
        meta_anchor: { x, y: name_y + TOKENS.meta_drop },
      })
    },
  }
}

/**
 * Children along one line at the node pitch, a plain segment in each gap.
 * This is the whole of sequential composition, so every wrapper kind
 * shares it and contributes only its own id to external segments.
 */
function run_box(children: ReadonlyArray<Box>): Omit<Box, 'id'> {
  const gaps = TOKENS.node_pitch * Math.max(0, children.length - 1)
  const width = children.reduce((total, child) => total + child.width, gaps)
  let exit_glyph: string | null = null
  for (const child of children) exit_glyph = child.exit_glyph ?? exit_glyph
  return {
    width,
    above: children.reduce((max, child) => Math.max(max, child.above), 0),
    below: children.reduce((max, child) => Math.max(max, child.below), 0),
    exit_glyph,
    place: (x, y, sink, label_drop) => {
      let cursor = x
      let previous: Box | null = null
      for (const child of children) {
        if (previous !== null) {
          sink.segments.push({
            role: 'line',
            from: previous.id,
            to: child.id,
            path: `M ${cursor} ${y} H ${cursor + TOKENS.node_pitch}`,
          })
          cursor += TOKENS.node_pitch
        }
        child.place(cursor, y, sink, label_drop)
        cursor += child.width
        previous = child
      }
    },
  }
}

/**
 * Nominal lane seats: multiples of the branch pitch centred on the through
 * line, with an even count skipping the centre row because the split and
 * join own it (artboard 01's two maps sit at plus and minus one pitch).
 */
function fan_seats(count: number): number[] {
  const centre = (count - 1) / 2
  const seats: number[] = []
  for (let index = 0; index < count; index += 1) {
    const seat = index - centre
    const steps = Number.isInteger(seat) ? seat : seat + 0.5 * Math.sign(seat)
    seats.push(steps * TOKENS.branch_pitch)
  }
  return seats
}

/**
 * Lane offsets for a fan: the nominal seats, except that content clearance
 * beats the nominal pitch. Each lane shifts down (carrying every lane
 * after it) until it clears the labels of the lane above, and the fan is
 * then pulled back onto the through line so the split and join corners
 * stay balanced.
 */
function fan_offsets(children: ReadonlyArray<Box>): number[] {
  const seats = fan_seats(children.length)
  const offsets: number[] = []
  let shift = 0
  let previous: { readonly box: Box; readonly offset: number } | null = null
  for (const [index, box] of children.entries()) {
    let offset = (seats[index] ?? 0) + shift
    if (previous !== null) {
      const need = previous.box.below + box.above + TOKENS.label_clear
      const gap = offset - previous.offset
      if (gap < need) {
        shift += need - gap
        offset += need - gap
      }
    }
    offsets.push(offset)
    previous = { box, offset }
  }
  const drift = Math.round(((offsets[0] ?? 0) + (offsets[offsets.length - 1] ?? 0)) / 2)
  return offsets.map((offset) => offset - drift)
}

/** The split's outbound corner pair: through line down (or up) into a lane. */
function split_path(x: number, y: number, lane_x: number, lane_y: number): string {
  if (lane_y === y) return `M ${x} ${y} H ${lane_x}`
  const r = TOKENS.corner_radius
  const channel = x + r
  const s = lane_y > y ? 1 : -1
  return (
    `M ${x} ${y} Q ${channel} ${y} ${channel} ${y + s * r} ` +
    `L ${channel} ${lane_y - s * r} Q ${channel} ${lane_y} ${channel + r} ${lane_y} H ${lane_x}`
  )
}

/** The join's inbound mirror: lane tail and corners back to the through line. */
function join_path(from_x: number, channel_x: number, lane_y: number, y: number): string {
  const r = TOKENS.corner_radius
  if (lane_y === y) return `M ${from_x} ${y} H ${channel_x + 2 * r}`
  const channel = channel_x + r
  const s = lane_y > y ? -1 : 1
  return (
    `M ${from_x} ${lane_y} H ${channel_x} Q ${channel} ${lane_y} ${channel} ${lane_y + s * r} ` +
    `L ${channel} ${y - s * r} Q ${channel} ${y} ${channel + r} ${y}`
  )
}

/**
 * A fan: lanes split off the through line, run the same horizontal span,
 * and rejoin at a junction puck. Lanes are left-aligned after a shared
 * lead so unequal children keep a common join channel, which is how the
 * artboard draws it.
 */
function fan_box(node: LayoutNode, children: ReadonlyArray<Box>): Box {
  const offsets = fan_offsets(children)
  const split = 2 * TOKENS.corner_radius
  const content = children.reduce((max, child) => Math.max(max, child.width), 0)
  const junction_id = `${node.id}:junction`
  const top = offsets[0] ?? 0
  const bottom = offsets[offsets.length - 1] ?? 0
  const first = children[0]
  const last = children[children.length - 1]
  return {
    id: node.id,
    width: split + TOKENS.lane_lead + content + TOKENS.lane_lead + split + TOKENS.junction_gap,
    above: -top + Math.max(first?.above ?? 0, FAN_LABEL_ABOVE),
    below: Math.max(bottom + (last?.below ?? 0), JUNCTION_BELOW),
    exit_glyph: null,
    place: (x, y, sink) => {
      const lane_x = x + split + TOKENS.lane_lead
      const channel_x = lane_x + content + TOKENS.lane_lead
      const join_x = channel_x + split
      const junction_x = join_x + TOKENS.junction_gap
      for (const [index, child] of children.entries()) {
        const lane_y = y + (offsets[index] ?? 0)
        sink.segments.push({
          role: 'branch_in',
          from: node.id,
          to: child.id,
          path: split_path(x, y, lane_x, lane_y),
        })
        child.place(lane_x, lane_y, sink, 0)
        sink.segments.push({
          role: 'branch_out',
          from: child.id,
          to: junction_id,
          path: join_path(lane_x + child.width, channel_x, lane_y, y),
        })
      }
      sink.segments.push({
        role: 'line',
        from: node.id,
        to: junction_id,
        path: `M ${join_x} ${y} H ${junction_x}`,
      })
      sink.junctions.push({
        id: junction_id,
        owner: node.id,
        center: { x: junction_x, y },
        radius: TOKENS.junction_radius,
        label_anchor: { x: junction_x, y: y + TOKENS.junction_label_drop },
      })
      const baseline = y + top - TOKENS.group_label_rise
      sink.group_labels.push({
        owner: node.id,
        tick: { x: x + TOKENS.corner_radius, y: baseline - GROUP_TICK_RISE },
        text_anchor: {
          x: x + TOKENS.corner_radius + TOKENS.group_text_indent,
          y: baseline,
        },
      })
    },
  }
}

/**
 * A retry or loop. Around a single puck it is the artboard's circle: the
 * puck at the west point, both attempt arcs to the east point, the caption
 * beside the top of the arc. Around a wider subtree the attempts traverse
 * the subtree itself, so only the repeat gets drawn: a return line routed
 * below the children, and the caption above the entry.
 */
function loop_box(node: LayoutNode, children: ReadonlyArray<Box>): Box {
  const inner = run_box(children)
  if (inner.width > 0) return loop_return_box(node, inner)
  const r = TOKENS.loop_radius
  const attempt_id = children[0]?.id ?? node.id
  return {
    id: node.id,
    width: 2 * r,
    above: r + LOOP_LABEL_ABOVE,
    below: r + LABEL_BELOW,
    exit_glyph: inner.exit_glyph,
    place: (x, y, sink) => {
      inner.place(x, y, sink, r)
      const exit = x + 2 * r
      sink.segments.push({
        role: 'loop_upper',
        from: node.id,
        to: attempt_id,
        path: `M ${x} ${y} A ${r} ${r} 0 0 1 ${exit} ${y}`,
      })
      sink.segments.push({
        role: 'loop_lower',
        from: node.id,
        to: attempt_id,
        path: `M ${x} ${y} A ${r} ${r} 0 0 0 ${exit} ${y}`,
      })
      const top = y - r
      sink.group_labels.push({
        owner: node.id,
        tick: { x: exit + TOKENS.label_clear, y: top - TOKENS.label_clear - GROUP_TICK_RISE },
        text_anchor: {
          x: exit + TOKENS.label_clear + TOKENS.group_text_indent,
          y: top - TOKENS.label_clear,
        },
      })
    },
  }
}

/** The wide-loop form: children inline, the repeat drawn as a return line. */
function loop_return_box(node: LayoutNode, inner: Omit<Box, 'id'>): Box {
  const r = TOKENS.corner_radius
  const depth = inner.below + LOOP_RETURN_CLEAR
  return {
    id: node.id,
    width: inner.width,
    above: Math.max(inner.above, FAN_LABEL_ABOVE),
    below: depth + LOOP_RETURN_PAD,
    exit_glyph: inner.exit_glyph,
    place: (x, y, sink) => {
      inner.place(x, y, sink, 0)
      const exit = x + inner.width
      const floor = y + depth
      sink.segments.push({
        role: 'loop_return',
        from: node.id,
        to: node.id,
        path:
          `M ${exit} ${y} Q ${exit + r} ${y} ${exit + r} ${y + r} L ${exit + r} ${floor - r} ` +
          `Q ${exit + r} ${floor} ${exit} ${floor} H ${x} ` +
          `Q ${x - r} ${floor} ${x - r} ${floor - r} L ${x - r} ${y + r} Q ${x - r} ${y} ${x} ${y}`,
      })
      const baseline = y - TOKENS.group_label_rise
      sink.group_labels.push({
        owner: node.id,
        tick: { x, y: baseline - GROUP_TICK_RISE },
        text_anchor: { x: x + TOKENS.group_text_indent, y: baseline },
      })
    },
  }
}

/** One bypass basin: down off the line, along the floor, back up (artboard 04). */
function basin_path(x: number, y: number, width: number, drop: number): string {
  const r = TOKENS.basin_radius
  const floor = y + drop
  const west = x + r
  const east = x + width - r
  return (
    `M ${x} ${y} Q ${west} ${y} ${west} ${y + r} L ${west} ${floor - r} ` +
    `Q ${west} ${floor} ${x + 2 * r} ${floor} H ${x + width - 2 * r} ` +
    `Q ${east} ${floor} ${east} ${floor - r} L ${east} ${y + r} Q ${east} ${y} ${x + width} ${y}`
  )
}

/**
 * A fallback: the primary keeps the through line, each further child gets
 * a bypass basin below it, stacked with the same clearance rule as fan
 * lanes. Backups centre inside the basin span because the basin mouth, not
 * the backup, owns the shoulders.
 */
function basin_box(node: LayoutNode, children: ReadonlyArray<Box>): Box {
  const primary = children[0]
  if (primary === undefined) return point_box(node)
  const backups = children.slice(1)
  const drops: number[] = []
  let drop = TOKENS.basin_drop
  let above_me: Box | null = null
  for (const backup of backups) {
    if (above_me !== null) {
      drop += Math.max(
        TOKENS.basin_drop,
        above_me.below + backup.above + TOKENS.label_clear,
      )
    }
    drops.push(drop)
    above_me = backup
  }
  const width = primary.width + 2 * TOKENS.basin_shoulder
  const last_drop = drops[drops.length - 1] ?? TOKENS.basin_drop
  const last_backup = backups[backups.length - 1]
  return {
    id: node.id,
    width,
    above: primary.above,
    below: last_drop + Math.max(last_backup?.below ?? 0, BASIN_LABEL_BELOW),
    exit_glyph: primary.exit_glyph,
    place: (x, y, sink) => {
      sink.segments.push({
        role: 'line',
        from: node.id,
        to: primary.id,
        path: `M ${x} ${y} H ${x + width}`,
      })
      primary.place(x + TOKENS.basin_shoulder, y, sink, 0)
      for (const [index, backup] of backups.entries()) {
        const backup_drop = drops[index] ?? TOKENS.basin_drop
        sink.segments.push({
          role: 'basin',
          from: node.id,
          to: backup.id,
          path: basin_path(x, y, width, backup_drop),
        })
        backup.place(x + (width - backup.width) / 2, y + backup_drop, sink, 0)
      }
      const baseline = y + last_drop + TOKENS.basin_drop + GROUP_TICK_RISE
      sink.group_labels.push({
        owner: node.id,
        tick: { x: x + BASIN_LABEL_INDENT, y: baseline - GROUP_TICK_RISE },
        text_anchor: {
          x: x + BASIN_LABEL_INDENT + TOKENS.group_text_indent,
          y: baseline,
        },
      })
    },
  }
}

/**
 * A map: the collapsed per-item child inline, then a reserved stretch of
 * line where instance ticks render. The reserve is static because
 * cardinality is runtime data and positions must not shift when it
 * arrives; `tick_marks` fits any count into the lane.
 */
function map_box(node: LayoutNode, children: ReadonlyArray<Box>): Box {
  const inner = run_box(children)
  const width = inner.width + TOKENS.tick_reserve
  const from = children[children.length - 1]?.id ?? node.id
  return {
    id: node.id,
    width,
    above: inner.above,
    below: inner.below,
    exit_glyph: inner.exit_glyph,
    place: (x, y, sink, label_drop) => {
      inner.place(x, y, sink, label_drop)
      sink.segments.push({
        role: 'line',
        from,
        to: node.id,
        path: `M ${x + inner.width} ${y} H ${x + width}`,
      })
      sink.tick_lanes.push({
        owner: node.id,
        y,
        x0: x + inner.width + TOKENS.tick_lead,
        x1: x + width,
      })
    },
  }
}

/**
 * Flag the flow's final through-line puck as the terminus. The last
 * matching glyph wins because a `<cycle>` back-reference can repeat the
 * id, and placement order puts the sequential exit after it.
 */
function mark_terminus(sink: Sink, exit_glyph: string | null): void {
  if (exit_glyph === null) return
  for (let index = sink.nodes.length - 1; index >= 0; index -= 1) {
    const glyph = sink.nodes[index]
    if (glyph?.id === exit_glyph) {
      sink.nodes[index] = { ...glyph, terminus: true, radius: TOKENS.terminus_radius }
      return
    }
  }
}

export type TickMarks = {
  readonly xs: ReadonlyArray<number>
  readonly decades: ReadonlyArray<{ readonly x: number; readonly value: number }>
  readonly pitch: number
}

/**
 * Instance tick positions inside a lane, as offsets from the lane's start.
 * Up to one decade of instances sits at the canvas pitch; past that the
 * ruler comb takes over (artboard 03): comb pitch, a gap after each
 * decade, and a faint numeral in each gap (or one pitch past the final
 * tick when the count closes a decade). A run longer than the lane
 * squeezes proportionally, keeping slots and gaps in ratio, because the
 * lane is statically sized and a failure must keep its slot.
 */
export function tick_marks(count: number, lane_length: number): TickMarks {
  if (!Number.isInteger(count) || count <= 0) return { xs: [], decades: [], pitch: 0 }
  const comb = count > TOKENS.decade
  const pitch = comb ? TOKENS.comb_pitch : TOKENS.tick_pitch
  const xs: number[] = []
  for (let index = 0; index < count; index += 1) {
    const gaps = comb ? Math.floor(index / TOKENS.decade) : 0
    xs.push(index * pitch + gaps * TOKENS.decade_gap)
  }
  const decades = comb ? decade_marks(xs, count, pitch) : []
  return squeeze_marks({ xs, decades, pitch }, lane_length)
}

/** A numeral per decade gap, or one pitch past a last tick closing a decade. */
function decade_marks(
  xs: ReadonlyArray<number>,
  count: number,
  pitch: number,
): Array<{ x: number; value: number }> {
  const decades: Array<{ x: number; value: number }> = []
  for (let value = TOKENS.decade; value <= count; value += TOKENS.decade) {
    const before = xs[value - 1]
    const after = xs[value]
    if (before === undefined) break
    decades.push({ value, x: after === undefined ? before + pitch : (before + after) / 2 })
  }
  return decades
}

/** Fit a run longer than its lane by scaling slots and gaps in ratio. */
function squeeze_marks(marks: TickMarks, lane_length: number): TickMarks {
  const span = marks.xs[marks.xs.length - 1] ?? 0
  if (span <= lane_length) return marks
  const squeeze = lane_length / span
  return {
    xs: marks.xs.map((x) => x * squeeze),
    decades: marks.decades.map((mark) => ({ value: mark.value, x: mark.x * squeeze })),
    pitch: marks.pitch * squeeze,
  }
}

export type ViewportFit = {
  readonly scale: number
  readonly offset_x: number
  readonly offset_y: number
  readonly pan_x: boolean
  readonly pan_y: boolean
}

/**
 * Q3's overflow ruling as arithmetic. Scale to fit the viewport but never
 * above 1 (a small flow keeps its set sizes; the margins grow instead) and
 * never below the name floor; a canvas still larger than the viewport at
 * the floor pans instead, west and top aligned so the flow reads from its
 * start. The half-pixel tolerance keeps float noise at an exact fit from
 * reporting a pan nothing could scroll.
 */
export function fit_viewport(
  size: { readonly width: number; readonly height: number },
  viewport_width: number,
  viewport_height: number,
): ViewportFit {
  const fit = Math.min(viewport_width / size.width, viewport_height / size.height)
  const scale = Math.max(Math.min(1, fit), MIN_SCALE)
  const pan_x = size.width * scale - viewport_width > 0.5
  const pan_y = size.height * scale - viewport_height > 0.5
  return {
    scale,
    offset_x: pan_x ? 0 : (viewport_width - size.width * scale) / 2,
    offset_y: pan_y ? 0 : (viewport_height - size.height * scale) / 2,
    pan_x,
    pan_y,
  }
}
