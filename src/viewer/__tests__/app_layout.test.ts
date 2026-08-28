/**
 * The metro-line layout: geometry pinned against the frozen design.
 *
 * The fixture flow (the run the artboards freeze) pins exact coordinates
 * for every geometry family at once; synthetic trees cover what the
 * fixture never exercises (deep nesting and lane repair, the wide-loop
 * return, stacked basins, every kind in the step registry, cycle
 * back-references, foreign kinds). The registry sweep iterates core's
 * STEP_KINDS so a new primitive fails here until layout maps it.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STEP_KINDS, type FlowNode } from '#core'
import {
  MIN_SCALE,
  TOKENS,
  fit_viewport,
  layout,
  tick_marks,
  type FlowLayout,
  type LayoutNode,
  type NodeGlyph,
  type Segment,
} from '../app/lib/layout.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const first_line = readFileSync(
  join(HERE, 'fixtures', 'fixture.trajectory.jsonl'),
  'utf8',
).split('\n')[0]

const structure = (JSON.parse(first_line ?? '') as { structure: FlowNode }).structure

function node_of(result: FlowLayout, id: string): NodeGlyph {
  const found = result.nodes.filter((node) => node.id === id)
  const last = found[found.length - 1]
  if (last === undefined) throw new Error(`no glyph ${id}`)
  return last
}

function segments_of(result: FlowLayout, role: Segment['role']): Segment[] {
  return result.segments.filter((segment) => segment.role === role)
}

function leaf(id: string): LayoutNode {
  return { kind: 'step', id }
}

describe('layout of the fixture flow', () => {
  const result = layout(structure)

  it('sizes the canvas from content plus margins', () => {
    expect(result.spine_y).toBe(227)
    expect(result.width).toBe(1652)
    expect(result.height).toBe(491)
  })

  it('is a pure function of structure alone', () => {
    expect(layout(structure)).toEqual(result)
  })

  it('places the spine pucks at the node pitch', () => {
    expect(node_of(result, 'fetch_brief').center).toEqual({ x: 100, y: 227 })
    expect(node_of(result, 'explode_sources').center).toEqual({ x: 228, y: 227 })
    expect(node_of(result, 'to_topic').center).toEqual({ x: 888, y: 227 })
    expect(node_of(result, 'finalize').center).toEqual({ x: 1580, y: 227 })
    expect(result.nodes).toHaveLength(9)
  })

  it('drops name and meta baselines below the line', () => {
    expect(node_of(result, 'fetch_brief').name_anchor).toEqual({ x: 100, y: 265 })
    expect(node_of(result, 'fetch_brief').meta_anchor).toEqual({ x: 100, y: 285 })
    expect(node_of(result, 'fetch_brief').label).toBe('fetch_brief')
  })

  it('straddles the through row with the two map lanes', () => {
    expect(node_of(result, 'summarize').center).toEqual({ x: 460, y: 135 })
    expect(node_of(result, 'score').center).toEqual({ x: 460, y: 319 })
  })

  it('draws the split and join corner paths of the parallel', () => {
    const into = segments_of(result, 'branch_in')
    expect(into.map((segment) => segment.to)).toEqual(['map_1', 'map_2'])
    expect(into[0]?.path).toBe(
      'M 356 227 Q 380 227 380 203 L 380 159 Q 380 135 404 135 H 460',
    )
    expect(into[1]?.path).toBe(
      'M 356 227 Q 380 227 380 251 L 380 295 Q 380 319 404 319 H 460',
    )
    const out = segments_of(result, 'branch_out')
    expect(out[0]?.path).toBe('M 620 135 H 676 Q 700 135 700 159 L 700 203 Q 700 227 724 227')
    expect(out.map((segment) => segment.to)).toEqual([
      'parallel_1:junction',
      'parallel_1:junction',
    ])
  })

  it('rejoins at a junction puck east of the join', () => {
    const junction = result.junctions[0]
    expect(result.junctions).toHaveLength(1)
    expect(junction?.id).toBe('parallel_1:junction')
    expect(junction?.owner).toBe('parallel_1')
    expect(junction?.center).toEqual({ x: 760, y: 227 })
    expect(junction?.radius).toBe(5.5)
    expect(junction?.label_anchor).toEqual({ x: 760, y: 264 })
  })

  it('reserves a static tick lane after each map child', () => {
    expect(result.tick_lanes).toEqual([
      { owner: 'map_1', y: 135, x0: 532, x1: 620 },
      { owner: 'map_2', y: 319, x0: 532, x1: 620 },
    ])
  })

  it('draws the retry as a circle with the puck at the west point', () => {
    expect(node_of(result, 'flaky_enrich').center).toEqual({ x: 1016, y: 227 })
    expect(node_of(result, 'flaky_enrich').name_anchor).toEqual({ x: 1016, y: 311 })
    expect(node_of(result, 'flaky_enrich').meta_anchor).toEqual({ x: 1016, y: 331 })
    const upper = segments_of(result, 'loop_upper')[0]
    const lower = segments_of(result, 'loop_lower')[0]
    expect(upper?.path).toBe('M 1016 227 A 46 46 0 0 1 1108 227')
    expect(lower?.path).toBe('M 1016 227 A 46 46 0 0 0 1108 227')
    expect(upper?.from).toBe('retry_1')
    expect(upper?.to).toBe('flaky_enrich')
  })

  it('routes the fallback backup through the bypass basin', () => {
    expect(node_of(result, 'always_throws').center).toEqual({ x: 1344, y: 227 })
    expect(node_of(result, 'safe_default').center).toEqual({ x: 1344, y: 319 })
    const basin = segments_of(result, 'basin')[0]
    expect(basin?.from).toBe('fallback_1')
    expect(basin?.to).toBe('safe_default')
    expect(basin?.path).toBe(
      'M 1236 227 Q 1268 227 1268 259 L 1268 287 Q 1268 319 1300 319 ' +
        'H 1388 Q 1420 319 1420 287 L 1420 259 Q 1420 227 1452 227',
    )
    const through = result.segments.find((segment) => segment.to === 'always_throws')
    expect(through?.path).toBe('M 1236 227 H 1452')
  })

  it('marks the final leaf as the terminus and nothing else', () => {
    const finalize = node_of(result, 'finalize')
    expect(finalize.terminus).toBe(true)
    expect(finalize.radius).toBe(TOKENS.terminus_radius)
    const rest = result.nodes.filter((node) => node.id !== 'finalize')
    expect(rest.every((node) => !node.terminus && node.radius === TOKENS.puck_radius)).toBe(
      true,
    )
  })

  it('enters from the west with a short stub', () => {
    const entry = segments_of(result, 'entry')[0]
    expect(entry).toEqual({
      role: 'entry',
      from: null,
      to: 'sequence_1',
      path: 'M 72 227 H 100',
    })
  })

  it('connects the spine with plain line segments', () => {
    const lines = segments_of(result, 'line').map((segment) => segment.path)
    expect(lines).toContain('M 100 227 H 228')
    expect(lines).toContain('M 228 227 H 356')
    expect(lines).toContain('M 760 227 H 888')
    expect(lines).toContain('M 888 227 H 1016')
    expect(lines).toContain('M 1108 227 H 1236')
    expect(lines).toContain('M 1452 227 H 1580')
    expect(result.segments).toHaveLength(18)
  })

  it('anchors the three group labels where the artboards put them', () => {
    expect(result.group_labels).toEqual([
      { owner: 'parallel_1', tick: { x: 380, y: 79 }, text_anchor: { x: 402, y: 83 } },
      { owner: 'retry_1', tick: { x: 1124, y: 161 }, text_anchor: { x: 1146, y: 165 } },
      { owner: 'fallback_1', tick: { x: 1276, y: 411 }, text_anchor: { x: 1298, y: 415 } },
    ])
  })
})

describe('layout of every registered kind', () => {
  const children_for = (kind: string): LayoutNode[] => {
    switch (kind) {
      case 'step':
      case 'suspend':
      case 'use':
        return []
      case 'pipe':
      case 'chain':
      case 'compose':
      case 'checkpoint':
      case 'stash':
      case 'timeout':
      case 'map':
      case 'retry':
        return [leaf(`${kind}_leaf`)]
      default:
        return [leaf(`${kind}_a`), leaf(`${kind}_b`)]
    }
  }

  const FANS = ['parallel', 'branch', 'adversarial', 'ensemble', 'tournament', 'consensus']

  for (const kind of STEP_KINDS) {
    it(`maps ${kind} to drawn geometry`, () => {
      const children = children_for(kind)
      const node: LayoutNode = children.length > 0
        ? { kind, id: `${kind}_1`, children }
        : { kind, id: `${kind}_1` }
      const result = layout(node)

      for (const segment of result.segments) {
        expect(segment.path).toMatch(/^M [\d.]/)
        expect(segment.path).not.toMatch(/NaN|undefined|-\d+\.\d{3,}/)
      }
      for (const child of children) {
        expect(node_of(result, child.id).center.x).toBeGreaterThanOrEqual(TOKENS.margin)
      }

      if (FANS.includes(kind)) {
        expect(result.junctions[0]?.id).toBe(`${kind}_1:junction`)
        expect(segments_of(result, 'branch_in')).toHaveLength(2)
        expect(segments_of(result, 'branch_out')).toHaveLength(2)
        expect(result.group_labels).toHaveLength(1)
      } else if (kind === 'retry') {
        expect(segments_of(result, 'loop_upper')).toHaveLength(1)
        expect(segments_of(result, 'loop_lower')).toHaveLength(1)
      } else if (kind === 'loop') {
        expect(segments_of(result, 'loop_return')).toHaveLength(1)
      } else if (kind === 'fallback') {
        expect(segments_of(result, 'basin')).toHaveLength(1)
      } else if (kind === 'map') {
        expect(result.tick_lanes).toHaveLength(1)
      } else if (children.length === 0) {
        expect(node_of(result, `${kind}_1`).center).toEqual({ x: 100, y: 82 })
      } else {
        expect(result.nodes).toHaveLength(children.length)
      }
    })
  }

  it('lays a loop with a body and guard as a return line around both', () => {
    const result = layout({
      kind: 'retry',
      id: 'wide',
      children: [leaf('body'), leaf('guard')],
    })
    expect(node_of(result, 'body').center).toEqual({ x: 100, y: 135 })
    expect(node_of(result, 'guard').center).toEqual({ x: 228, y: 135 })
    expect(segments_of(result, 'loop_return')[0]?.path).toBe(
      'M 228 135 Q 252 135 252 159 L 252 213 Q 252 237 228 237 H 100 ' +
        'Q 76 237 76 213 L 76 159 Q 76 135 100 135',
    )
    expect(result.group_labels).toEqual([
      { owner: 'wide', tick: { x: 100, y: 79 }, text_anchor: { x: 122, y: 83 } },
    ])
  })
})

describe('layout under nesting and hostile shapes', () => {
  it('pushes a nested fan lane past the nominal pitch and recentres', () => {
    const result = layout({
      kind: 'parallel',
      id: 'outer',
      children: [
        leaf('solo'),
        {
          kind: 'parallel',
          id: 'inner',
          children: [leaf('deep_a'), leaf('deep_b')],
        },
      ],
    })
    const solo = node_of(result, 'solo').center
    const deep_a = node_of(result, 'deep_a').center
    const deep_b = node_of(result, 'deep_b').center
    expect(solo).toEqual({ x: 204, y: 135 })
    expect(deep_a).toEqual({ x: 308, y: 276 })
    expect(deep_b).toEqual({ x: 308, y: 460 })
    expect(deep_a.y - solo.y).toBe(233 - TOKENS.branch_pitch)
    expect(deep_b.y - deep_a.y).toBe(2 * TOKENS.branch_pitch)
  })

  it('stacks extra fallback children as deeper basins', () => {
    const result = layout({
      kind: 'fallback',
      id: 'triple',
      children: [leaf('primary'), leaf('backup_1'), leaf('backup_2')],
    })
    const basins = segments_of(result, 'basin')
    expect(basins).toHaveLength(2)
    const primary_y = node_of(result, 'primary').center.y
    expect(node_of(result, 'backup_1').center.y - primary_y).toBe(92)
    expect(node_of(result, 'backup_2').center.y - primary_y).toBe(184)
  })

  it('renders a cycle back-reference as a second puck sharing the id', () => {
    const result = layout({
      kind: 'sequence',
      id: 'seq',
      children: [leaf('a'), { kind: '<cycle>', id: 'a' }],
    })
    const glyphs = result.nodes.filter((node) => node.id === 'a')
    expect(glyphs).toHaveLength(2)
    expect(glyphs[0]?.terminus).toBe(false)
    expect(glyphs[1]?.terminus).toBe(true)
  })

  it('keeps foreign shapes harmless', () => {
    expect(layout(null)).toEqual({
      width: 144,
      height: 144,
      spine_y: 72,
      nodes: [],
      junctions: [],
      segments: [],
      group_labels: [],
      tick_lanes: [],
    })
    const unknown = layout({ kind: 'hologram', id: 'h' })
    expect(node_of(unknown, 'h').center).toEqual({ x: 100, y: 82 })
    const wrapped = layout({ kind: 'hologram', id: 'h', children: [leaf('inside')] })
    expect(node_of(wrapped, 'inside').center).toEqual({ x: 100, y: 82 })
    const bare_sequence = layout({ kind: 'sequence', id: 's', children: [] })
    expect(node_of(bare_sequence, 's').center).toEqual({ x: 100, y: 82 })
    const bare_map = layout({ kind: 'map', id: 'm', children: [] })
    expect(bare_map.tick_lanes).toEqual([{ owner: 'm', y: 72, x0: 172, x1: 260 }])
  })

  it('runs a single-lane fan straight through the centre row', () => {
    const result = layout({ kind: 'branch', id: 'only', children: [leaf('arm')] })
    const spine = result.spine_y
    expect(node_of(result, 'arm').center.y).toBe(spine)
    expect(segments_of(result, 'branch_in')[0]?.path).toBe(`M 100 ${spine} H 204`)
  })

  it('prefers a display_name over the id as the glyph label', () => {
    const named = layout({
      kind: 'step',
      id: 'step_9',
      config: { display_name: 'triage' },
    })
    expect(node_of(named, 'step_9').label).toBe('triage')
    const empty = layout({ kind: 'step', id: 'step_9', config: { display_name: '' } })
    expect(node_of(empty, 'step_9').label).toBe('step_9')
    const wrong_type = layout({ kind: 'step', id: 'step_9', config: { display_name: 4 } })
    expect(node_of(wrong_type, 'step_9').label).toBe('step_9')
  })
})

describe('tick_marks', () => {
  it('sits a small cohort at the canvas pitch with no decades', () => {
    expect(tick_marks(3, 88)).toEqual({ xs: [0, 30, 60], decades: [], pitch: 30 })
    expect(tick_marks(1, 88)).toEqual({ xs: [0], decades: [], pitch: 30 })
    expect(tick_marks(10, 400).xs[9]).toBe(270)
    expect(tick_marks(10, 400).decades).toEqual([])
  })

  it('switches to the ruler comb past one decade', () => {
    const marks = tick_marks(12, 1000)
    expect(marks.pitch).toBe(18)
    expect(marks.xs[9]).toBe(162)
    expect(marks.xs[10]).toBe(188)
    expect(marks.xs[11]).toBe(206)
    expect(marks.decades).toEqual([{ value: 10, x: 175 }])
  })

  it('closes a full decade with a numeral one pitch past the last tick', () => {
    const marks = tick_marks(50, 1000)
    expect(marks.xs[49]).toBe(914)
    expect(marks.decades.map((mark) => mark.value)).toEqual([10, 20, 30, 40, 50])
    expect(marks.decades[4]).toEqual({ value: 50, x: 932 })
  })

  it('squeezes proportionally into a lane shorter than the run', () => {
    const marks = tick_marks(50, 88)
    const last = marks.xs[marks.xs.length - 1]
    expect(last).toBeCloseTo(88, 10)
    expect(marks.pitch).toBeCloseTo(18 * (88 / 914), 10)
    expect(marks.decades[0]?.x).toBeCloseTo(175 * (88 / 914), 10)
  })

  it('rejects counts that are not positive integers', () => {
    expect(tick_marks(0, 88)).toEqual({ xs: [], decades: [], pitch: 0 })
    expect(tick_marks(-3, 88)).toEqual({ xs: [], decades: [], pitch: 0 })
    expect(tick_marks(2.5, 88)).toEqual({ xs: [], decades: [], pitch: 0 })
  })
})

describe('fit_viewport', () => {
  it('derives the scale floor from the name sizes', () => {
    expect(MIN_SCALE).toBe(11 / 15)
  })

  it('centres a small flow without scaling up', () => {
    const fit = fit_viewport({ width: 700, height: 400 }, 1440, 900)
    expect(fit).toEqual({ scale: 1, offset_x: 370, offset_y: 250, pan_x: false, pan_y: false })
  })

  it('scales the fixture canvas to fit a 1440x900 viewport', () => {
    const fit = fit_viewport({ width: 1652, height: 491 }, 1440, 900)
    expect(fit.scale).toBeCloseTo(1440 / 1652, 10)
    expect(fit.pan_x).toBe(false)
    expect(fit.pan_y).toBe(false)
    expect(fit.offset_x).toBeCloseTo(0, 10)
    expect(fit.offset_y).toBeCloseTo((900 - 491 * (1440 / 1652)) / 2, 10)
  })

  it('stops shrinking at the name floor and pans instead', () => {
    const fit = fit_viewport({ width: 2200, height: 300 }, 1440, 900)
    expect(fit.scale).toBe(MIN_SCALE)
    expect(fit.pan_x).toBe(true)
    expect(fit.offset_x).toBe(0)
    expect(fit.pan_y).toBe(false)
  })

  it('pans vertically when height is the axis past the floor', () => {
    const fit = fit_viewport({ width: 800, height: 2000 }, 1440, 900)
    expect(fit.scale).toBe(MIN_SCALE)
    expect(fit.pan_x).toBe(false)
    expect(fit.pan_y).toBe(true)
    expect(fit.offset_y).toBe(0)
  })

  it('reports no pan at an exact fit', () => {
    const fit = fit_viewport({ width: 1440, height: 900 }, 1440, 900)
    expect(fit).toEqual({ scale: 1, offset_x: 0, offset_y: 0, pan_x: false, pan_y: false })
  })
})

describe('the frozen spacing system', () => {
  it('pins every token', () => {
    expect(TOKENS).toEqual({
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
    })
  })
})
