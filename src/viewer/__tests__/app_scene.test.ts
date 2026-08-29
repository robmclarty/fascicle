/**
 * The scene: wire session folding, structural captions, and the geometry
 * join, pinned against the frozen design.
 *
 * The fixture's `flow_structure` line drives the T+0 contract: folding that
 * one frame must yield every artboard-06 caption (`STEP`, `MAP` with no xN,
 * the retry budget, the fallback seats, `TERMINUS`) with every node pending.
 * Synthetic trees cover what the fixture never exercises: malformed wire
 * shapes, caption edges, and a scene built from a layout the session does
 * not know.
 *
 * Equivalent-mutant ledger:
 *   - `typeof attempts !== 'number'` -> `false` in `retry_caption`: the
 *     `!Number.isInteger(attempts)` clause that follows already rejects
 *     every non-number without coercion, so the typeof guard changes no
 *     outcome; it exists for the type narrowing the template below needs.
 *   - the `?.` in `is_map_child`'s `nodes_by_id.get(parent_id)?.kind`: a
 *     `parent_id` only ever comes from the `parents` map, and `scene_context`
 *     fills `parents` and `nodes_by_id` from the same walk, so the lookup is
 *     never undefined here. The optional chain mirrors `attempt_parent` for
 *     one reading of the tree; dropping it changes no reachable outcome.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TOKENS, layout, type LayoutNode } from '../app/lib/layout.js'
import { reduce, t_plus_ms, type StructureNode } from '../app/lib/reduce.js'
import {
  BLOOM_RADIUS,
  EMPTY_SESSION,
  HALO_RADIUS,
  apply_frame,
  build_scene,
  node_captions,
  type Session,
  type SceneTickLane,
} from '../app/lib/scene.js'
import { map_trajectory } from './fixtures/map-instances.js'
import {
  TREATMENTS_EMIT_CUT,
  treatments_trajectory,
} from './fixtures/state-treatments.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const lines = readFileSync(join(HERE, 'fixtures', 'fixture.trajectory.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)

const events = lines.map((line) => JSON.parse(line) as unknown)

const first_event = events[0] as { readonly structure: StructureNode }

/** Fold a prefix of the fixture into a session, frame by frame. */
function fold_fixture(count: number): Session {
  let session = EMPTY_SESSION
  for (const event of events.slice(0, count)) session = apply_frame(session, event)
  return session
}

/** The scene a session draws, laid out from its own structure. */
function scene_of(session: Session): ReturnType<typeof build_scene> {
  return build_scene(layout(session.structure), session)
}

// Folding stays inside the `it` bodies throughout this file: a describe-scope
// fold runs at collection, and a mutant that makes it throw fails the file
// before any test executes, which stryker scores as survived rather than
// killed (no covering test ever reported the failure).
describe('apply_frame with the fixture structure line', () => {
  it('adopts the sanitized tree verbatim from a well-formed line', () => {
    expect(fold_fixture(1).structure).toStrictEqual(first_event.structure)
  })

  it('folds the structure event itself, so run id and T+0 come off one line', () => {
    const session = fold_fixture(1)
    expect(session.state.run_id).toBe('42b20e54-41e6-47b2-8697-bda677867762')
    expect(t_plus_ms(session.state)).toBe(0)
  })

  it('seeds every structure node pending before any span arrives', () => {
    const session = fold_fixture(1)
    expect(session.state.nodes.size).toBe(15)
    for (const node of session.state.nodes.values()) {
      expect(node.status).toBe('pending')
    }
  })

  it('matches a from-scratch reduce over any fixture prefix', () => {
    let folded = EMPTY_SESSION
    for (const event of events) folded = apply_frame(folded, event)
    expect(folded.state).toEqual(reduce(first_event.structure, events))
  })
})

describe('apply_frame on the rest of the wire', () => {
  it('returns the same session for a value the fold ignores', () => {
    expect(apply_frame(EMPTY_SESSION, 'half a line')).toBe(EMPTY_SESSION)
    expect(apply_frame(EMPTY_SESSION, { kind: 9 })).toBe(EMPTY_SESSION)
    expect(apply_frame(EMPTY_SESSION, null)).toBe(EMPTY_SESSION)
    expect(apply_frame(EMPTY_SESSION, ['flow_structure'])).toBe(EMPTY_SESSION)
  })

  it('folds a plain event and keeps the structure by reference', () => {
    const session = fold_fixture(1)
    const next = apply_frame(session, { kind: 'zap', ts: 1787368870082 + 130 })
    expect(next.structure).toBe(session.structure)
    expect(t_plus_ms(next.state)).toBe(130)
  })

  it('accretes spans into state before any structure exists (C7)', () => {
    const next = apply_frame(EMPTY_SESSION, {
      kind: 'span_start',
      span_id: 'step:1',
      name: 'step',
      id: 'lonely',
      run_id: 'r1',
      ts: 4,
    })
    expect(next.structure).toBeNull()
    expect(next.state.run_id).toBe('r1')
    expect(next.state.nodes.get('lonely')?.status).toBe('active')
  })

  it('starts over for a new run on the next structure line (Q7)', () => {
    const busy = apply_frame(fold_fixture(1), {
      kind: 'span_start',
      span_id: 'step:1',
      name: 'step',
      id: 'fetch_brief',
      ts: 1787368870090,
    })
    const next = apply_frame(busy, {
      kind: 'flow_structure',
      structure: { kind: 'step', id: 'solo' },
      run_id: 'r2',
      ts: 9000,
    })
    expect(next.structure).toStrictEqual({ kind: 'step', id: 'solo' })
    expect(next.state.run_id).toBe('r2')
    expect(next.state.t0_ts).toBe(9000)
    expect(next.state.nodes.size).toBe(1)
    expect(next.state.nodes.get('solo')?.status).toBe('pending')
  })

  it('keeps the canvas it has when a structure line carries no readable tree', () => {
    const session = fold_fixture(1)
    for (const structure of [42, null, [1], { kind: 'step' }, { id: 'a' }, undefined]) {
      const next = apply_frame(session, { kind: 'flow_structure', structure, ts: 9000 })
      expect(next.structure).toBe(session.structure)
    }
  })

  it('does not reseed off a non-structure kind that happens to carry a tree', () => {
    const next = apply_frame(EMPTY_SESSION, {
      kind: 'span_start',
      structure: { kind: 'step', id: 'a' },
    })
    expect(next.structure).toBeNull()
  })
})

/** Reseed an empty session with the given raw structure value. */
function read(structure: unknown): LayoutNode | null {
  return apply_frame(EMPTY_SESSION, { kind: 'flow_structure', structure }).structure
}

describe('reading the structure tree off the wire', () => {
  it('omits absent children and config rather than inventing empties', () => {
    expect(read({ kind: 'step', id: 'a' })).toStrictEqual({ kind: 'step', id: 'a' })
  })

  it('keeps a record config and drops any other shape', () => {
    expect(read({ kind: 'retry', id: 'r', config: { max_attempts: 2 } })).toStrictEqual({
      kind: 'retry',
      id: 'r',
      config: { max_attempts: 2 },
    })
    expect(read({ kind: 'step', id: 'a', config: 'loud' })).toStrictEqual({
      kind: 'step',
      id: 'a',
    })
    expect(read({ kind: 'step', id: 'a', config: [1] })).toStrictEqual({
      kind: 'step',
      id: 'a',
    })
  })

  it('drops children that do not hold their shape and keeps the rest', () => {
    expect(
      read({
        kind: 'sequence',
        id: 's',
        children: [
          { kind: 'step', id: 'a' },
          { kind: 'step' },
          5,
          null,
          { kind: 'step', id: 'b' },
        ],
      }),
    ).toStrictEqual({
      kind: 'sequence',
      id: 's',
      children: [
        { kind: 'step', id: 'a' },
        { kind: 'step', id: 'b' },
      ],
    })
  })

  it('treats non-array children as a leaf', () => {
    expect(read({ kind: 'sequence', id: 's', children: 'none' })).toStrictEqual({
      kind: 'sequence',
      id: 's',
    })
  })

  it('sanitizes recursively, not just at the root', () => {
    expect(
      read({
        kind: 'sequence',
        id: 's',
        children: [{ kind: 'map', id: 'm', children: [{ kind: 'step', id: 'ok' }, 7] }],
      }),
    ).toStrictEqual({
      kind: 'sequence',
      id: 's',
      children: [{ kind: 'map', id: 'm', children: [{ kind: 'step', id: 'ok' }] }],
    })
  })
})

describe('node_captions', () => {
  it('gives the fixture flow its artboard-06 meta lines', () => {
    const captions = node_captions(first_event.structure)
    expect(captions.get('fetch_brief')).toBe('STEP')
    expect(captions.get('explode_sources')).toBe('STEP')
    expect(captions.get('summarize')).toBe('MAP')
    expect(captions.get('score')).toBe('MAP')
    expect(captions.get('to_topic')).toBe('STEP')
    expect(captions.get('flaky_enrich')).toBe('RETRY · 3 ATTEMPTS')
    expect(captions.get('always_throws')).toBe('STEP · PRIMARY')
    expect(captions.get('safe_default')).toBe('STEP · BACKUP')
    expect(captions.get('finalize')).toBe('STEP')
  })

  it('captions combinators with their own kind', () => {
    const captions = node_captions(first_event.structure)
    expect(captions.get('sequence_1')).toBe('SEQUENCE')
    expect(captions.get('parallel_1')).toBe('PARALLEL')
    expect(captions.get('map_1')).toBe('MAP')
    expect(captions.get('retry_1')).toBe('RETRY')
    expect(captions.get('fallback_1')).toBe('FALLBACK')
  })

  it('is empty without a structure', () => {
    expect(node_captions(null).size).toBe(0)
  })

  it('speaks the retry budget only when config holds a whole positive count', () => {
    const child = { kind: 'step', id: 'a' }
    const budget = (config?: Record<string, unknown>): string | undefined =>
      node_captions({ kind: 'retry', id: 'r', children: [child], ...(config ? { config } : {}) }).get('a')
    expect(budget({ max_attempts: 1 })).toBe('RETRY · 1 ATTEMPT')
    expect(budget({ max_attempts: 4 })).toBe('RETRY · 4 ATTEMPTS')
    expect(budget({ max_attempts: 0 })).toBe('RETRY')
    expect(budget({ max_attempts: 2.5 })).toBe('RETRY')
    expect(budget({ max_attempts: '3' })).toBe('RETRY')
    expect(budget()).toBe('RETRY')
  })

  it('collapses loop children the way map children collapse', () => {
    const captions = node_captions({
      kind: 'loop',
      id: 'l',
      children: [{ kind: 'step', id: 'body' }],
    })
    expect(captions.get('body')).toBe('LOOP')
  })

  it('seats every fallback child by its own kind', () => {
    const captions = node_captions({
      kind: 'fallback',
      id: 'f',
      children: [
        { kind: 'use', id: 'p' },
        { kind: 'step', id: 'b1' },
        { kind: 'step', id: 'b2' },
      ],
    })
    expect(captions.get('p')).toBe('USE · PRIMARY')
    expect(captions.get('b1')).toBe('STEP · BACKUP')
    expect(captions.get('b2')).toBe('STEP · BACKUP')
  })

  it('leaves children of a foreign kind wearing their own kind (C7)', () => {
    const captions = node_captions({
      kind: 'quantum',
      id: 'q',
      children: [{ kind: 'step', id: 'a' }],
    })
    expect(captions.get('q')).toBe('QUANTUM')
    expect(captions.get('a')).toBe('STEP')
  })

  it('keeps the first caption for a shared id, matching the fold join', () => {
    const captions = node_captions({
      kind: 'sequence',
      id: 's',
      children: [
        { kind: 'map', id: 'm', children: [{ kind: 'step', id: 'shared' }] },
        {
          kind: 'fallback',
          id: 'f',
          children: [
            { kind: 'step', id: 'shared' },
            { kind: 'step', id: 'b' },
          ],
        },
      ],
    })
    expect(captions.get('shared')).toBe('MAP')
    expect(captions.get('b')).toBe('STEP · BACKUP')
  })
})

describe('build_scene', () => {
  it('draws the fixture T+0 scaffold: every caption pinned, every node pending', () => {
    const scene = scene_of(fold_fixture(1))
    expect(scene.nodes.map((node) => [node.glyph.id, node.meta, node.status])).toEqual([
      ['fetch_brief', 'STEP', 'pending'],
      ['explode_sources', 'STEP', 'pending'],
      ['summarize', 'MAP', 'pending'],
      ['score', 'MAP', 'pending'],
      ['to_topic', 'STEP', 'pending'],
      ['flaky_enrich', 'RETRY · 3 ATTEMPTS', 'pending'],
      ['always_throws', 'STEP · PRIMARY', 'pending'],
      ['safe_default', 'STEP · BACKUP', 'pending'],
      ['finalize', 'TERMINUS', 'pending'],
    ])
  })

  it('labels the fixture junction and groups the way artboard 06 reads', () => {
    const scene = scene_of(fold_fixture(1))
    expect(scene.junctions.map((junction) => [junction.glyph.id, junction.label, junction.status])).toEqual([
      ['parallel_1:junction', 'merge', 'pending'],
    ])
    expect(scene.group_labels.map((label) => [label.anchor.owner, label.text])).toEqual([
      ['parallel_1', 'PARALLEL_1'],
      ['retry_1', 'RETRY_1'],
      ['fallback_1', 'FALLBACK_1 · ARMED'],
    ])
  })

  it('carries the folded status onto the node that owns the span', () => {
    const session = apply_frame(fold_fixture(1), {
      kind: 'span_start',
      span_id: 'step:x',
      name: 'step',
      id: 'fetch_brief',
      ts: 1787368870083,
    })
    const scene = scene_of(session)
    const statuses = new Map(scene.nodes.map((node) => [node.glyph.id, node.status]))
    expect(statuses.get('fetch_brief')).toBe('active')
    expect(statuses.get('explode_sources')).toBe('pending')
  })

  it('lights the junction from its owning fan, not its own synthetic id', () => {
    const scene = scene_of(fold_fixture(7))
    expect(scene.junctions[0]?.status).toBe('active')
  })

  it('marks the terminus even when a caption frames the same node', () => {
    const scene = scene_of(
      apply_frame(EMPTY_SESSION, {
        kind: 'flow_structure',
        structure: { kind: 'map', id: 'm', children: [{ kind: 'step', id: 'only' }] },
      }),
    )
    expect(scene.nodes.map((node) => [node.glyph.id, node.meta])).toEqual([
      ['only', 'TERMINUS'],
    ])
  })

  it('degrades a glyph the session does not know to its kind, pending', () => {
    const foreign = layout({
      kind: 'parallel',
      id: 'zp',
      children: [
        { kind: 'quantum', id: 'z1' },
        { kind: 'step', id: 'z2' },
      ],
    })
    const scene = build_scene(foreign, EMPTY_SESSION)
    expect(scene.nodes.map((node) => [node.glyph.id, node.meta, node.status])).toEqual([
      ['z1', 'QUANTUM', 'pending'],
      ['z2', 'STEP', 'pending'],
    ])
    expect(scene.junctions[0]?.status).toBe('pending')
    expect(scene.group_labels.map((label) => label.text)).toEqual(['ZP'])
  })

  it('is empty before any structure arrives', () => {
    const scene = scene_of(EMPTY_SESSION)
    expect(scene.nodes).toEqual([])
    expect(scene.junctions).toEqual([])
    expect(scene.group_labels).toEqual([])
    expect(scene.segments).toEqual([])
    expect(scene.fail_marks).toEqual([])
    expect(scene.tick_lanes).toEqual([])
    expect(scene.cards).toEqual([])
  })
})

/** Every segment's state, keyed `role:from>to` so shared endpoints stay apart. */
function segment_states(session: Session): ReadonlyMap<string, string> {
  return new Map(
    scene_of(session).segments.map((entry) => [
      `${entry.segment.role}:${entry.segment.from ?? '·'}>${entry.segment.to}`,
      entry.state,
    ]),
  )
}

/** Fold a synthetic structure frame and then the given wire events. */
function fold_events(structure: unknown, wire: ReadonlyArray<unknown>): Session {
  let session = apply_frame(EMPTY_SESSION, { kind: 'flow_structure', structure, ts: 0 })
  for (const event of wire) session = apply_frame(session, event)
  return session
}

describe('segment states across the fixture run', () => {
  it('draws the whole scaffold unbuilt from the structure line alone', () => {
    const states = segment_states(fold_fixture(1))
    expect(states.size).toBe(18)
    expect(new Set(states.values())).toEqual(new Set(['unbuilt']))
  })

  it('keeps the entry dark while only the wrapper sequence is open', () => {
    const states = segment_states(fold_fixture(2))
    expect(new Set(states.values())).toEqual(new Set(['unbuilt']))
  })

  it('marches the entry while the first leaf runs, alone', () => {
    const states = segment_states(fold_fixture(3))
    expect(states.get('entry:·>sequence_1')).toBe('live')
    expect(
      [...states.entries()].filter(([, state]) => state !== 'unbuilt'),
    ).toEqual([['entry:·>sequence_1', 'live']])
  })

  it('greys the entry the moment the first leaf settles', () => {
    expect(segment_states(fold_fixture(4)).get('entry:·>sequence_1')).toBe('traversed')
  })

  it('marches a spine gap while the leaf it feeds runs', () => {
    const states = segment_states(fold_fixture(5))
    expect(states.get('line:fetch_brief>explode_sources')).toBe('live')
  })

  it('reads a fan approach and lane through the first leaf inside', () => {
    const states = segment_states(fold_fixture(10))
    expect(states.get('line:explode_sources>parallel_1')).toBe('live')
    expect(states.get('branch_in:parallel_1>map_1')).toBe('live')
    expect(states.get('branch_in:parallel_1>map_2')).toBe('unbuilt')
    expect(states.get('line:summarize>map_1')).toBe('unbuilt')
    expect(states.get('branch_out:map_1>parallel_1:junction')).toBe('unbuilt')
  })

  it('marches the second lane once its own leaf runs', () => {
    expect(segment_states(fold_fixture(13)).get('branch_in:parallel_1>map_2')).toBe('live')
  })

  it('earns a map exit only when the map itself closes, join legs later still', () => {
    const states = segment_states(fold_fixture(21))
    expect(states.get('line:summarize>map_1')).toBe('traversed')
    expect(states.get('branch_in:parallel_1>map_1')).toBe('traversed')
    expect(states.get('line:explode_sources>parallel_1')).toBe('traversed')
    expect(states.get('branch_out:map_1>parallel_1:junction')).toBe('unbuilt')
    expect(states.get('line:parallel_1>parallel_1:junction')).toBe('unbuilt')
  })

  it('joins the fan at the junction when the fan completes', () => {
    const states = segment_states(fold_fixture(24))
    expect(states.get('branch_out:map_1>parallel_1:junction')).toBe('traversed')
    expect(states.get('branch_out:map_2>parallel_1:junction')).toBe('traversed')
    expect(states.get('line:parallel_1>parallel_1:junction')).toBe('traversed')
  })

  it('keeps the loop dark while the retry is open but unattempted', () => {
    const states = segment_states(fold_fixture(27))
    expect(states.get('loop_upper:retry_1>flaky_enrich')).toBe('unbuilt')
    expect(states.get('loop_lower:retry_1>flaky_enrich')).toBe('unbuilt')
    expect(states.get('line:to_topic>retry_1')).toBe('unbuilt')
  })

  it('sends the light around the live lane on the first attempt', () => {
    const states = segment_states(fold_fixture(28))
    expect(states.get('loop_upper:retry_1>flaky_enrich')).toBe('live')
    expect(states.get('loop_lower:retry_1>flaky_enrich')).toBe('unbuilt')
    // The spine into the loop settles at once: re-entries belong to the arcs.
    expect(states.get('line:to_topic>retry_1')).toBe('traversed')
  })

  it('holds the artboard-01 loop through the backoff pause', () => {
    const states = segment_states(fold_fixture(29))
    expect(states.get('loop_upper:retry_1>flaky_enrich')).toBe('live')
    expect(states.get('loop_lower:retry_1>flaky_enrich')).toBe('traversed')
    expect(states.get('line:retry_1>fallback_1')).toBe('unbuilt')
  })

  it('keeps the live lane amber through the second attempt', () => {
    expect(segment_states(fold_fixture(30)).get('loop_upper:retry_1>flaky_enrich')).toBe(
      'live',
    )
  })

  it('parks the live lane grey once the attempt settles clean', () => {
    expect(segment_states(fold_fixture(31)).get('loop_upper:retry_1>flaky_enrich')).toBe(
      'traversed',
    )
  })

  it('earns the loop exit only after the retry closes, into the fallback', () => {
    const closed = segment_states(fold_fixture(32))
    expect(closed.get('loop_upper:retry_1>flaky_enrich')).toBe('traversed')
    expect(closed.get('line:retry_1>fallback_1')).toBe('unbuilt')
    const primary_running = segment_states(fold_fixture(34))
    expect(primary_running.get('line:retry_1>fallback_1')).toBe('live')
    expect(primary_running.get('line:fallback_1>always_throws')).toBe('live')
  })

  it('reroutes through the basin exactly while the backup runs', () => {
    expect(segment_states(fold_fixture(35)).get('basin:fallback_1>safe_default')).toBe(
      'unbuilt',
    )
    expect(segment_states(fold_fixture(36)).get('basin:fallback_1>safe_default')).toBe(
      'live',
    )
    expect(segment_states(fold_fixture(37)).get('basin:fallback_1>safe_default')).toBe(
      'traversed',
    )
  })

  it('kills the scarred primary through-line the moment the fallback fires', () => {
    // Event 34 opens always_throws: its through-line is live, nothing scarred.
    const running = segment_states(fold_fixture(34))
    expect(running.get('line:fallback_1>always_throws')).toBe('live')
    // Event 35 is the terminal throw: the primary path becomes the dead segment.
    const scarred = segment_states(fold_fixture(35))
    expect(scarred.get('line:fallback_1>always_throws')).toBe('unbuilt')
    // The approach into the fallback still greys: it feeds the wrapper, not the
    // primary, so the light is shown reaching the scar before it reroutes.
    expect(scarred.get('line:retry_1>fallback_1')).toBe('traversed')
  })

  it('leaves the dead segment unbuilt while every other line greys at done', () => {
    const states = segment_states(fold_fixture(events.length))
    expect(states.size).toBe(18)
    expect(states.get('line:fallback_1>always_throws')).toBe('unbuilt')
    const rest = [...states.entries()].filter(
      ([key]) => key !== 'line:fallback_1>always_throws',
    )
    expect(rest).toHaveLength(17)
    expect(new Set(rest.map(([, state]) => state))).toEqual(new Set(['traversed']))
  })
})

describe('fail marks on the retry circle', () => {
  it('shows nothing while no attempt has failed', () => {
    expect(scene_of(fold_fixture(28)).fail_marks).toEqual([])
  })

  it('orbits one ember mark at the artboard seat after the first failure', () => {
    const session = fold_fixture(29)
    const marks = scene_of(session).fail_marks
    expect(marks).toHaveLength(1)
    const glyph = layout(session.structure).nodes.find(
      (node) => node.id === 'flaky_enrich',
    )
    const orbit = TOKENS.loop_radius + 14
    expect(marks[0]?.x).toBeCloseTo(
      (glyph?.center.x ?? 0) + TOKENS.loop_radius + Math.SQRT1_2 * orbit,
    )
    expect(marks[0]?.y).toBeCloseTo((glyph?.center.y ?? 0) + Math.SQRT1_2 * orbit)
  })

  it('steps older marks onward so the newest keeps the artboard seat', () => {
    const structure = {
      kind: 'retry',
      id: 'r',
      config: { max_attempts: 3 },
      children: [{ kind: 'step', id: 'a' }],
    }
    const session = fold_events(structure, [
      { kind: 'span_start', span_id: 'r1', name: 'retry', id: 'r', ts: 0 },
      { kind: 'span_start', span_id: 'a1', name: 'step', id: 'a', parent_span_id: 'r1', ts: 1 },
      { kind: 'span_end', span_id: 'a1', id: 'a', error: 'x', ts: 2 },
      { kind: 'span_start', span_id: 'a2', name: 'step', id: 'a', parent_span_id: 'r1', ts: 3 },
      { kind: 'span_end', span_id: 'a2', id: 'a', error: 'x', ts: 4 },
    ])
    const marks = scene_of(session).fail_marks
    expect(marks).toHaveLength(2)
    const glyph = layout(session.structure).nodes.find((node) => node.id === 'a')
    const center_x = (glyph?.center.x ?? 0) + TOKENS.loop_radius
    const orbit = TOKENS.loop_radius + 14
    // Oldest first in the array: pushed to due south, the newest at southeast.
    expect(marks[0]?.x).toBeCloseTo(center_x)
    expect(marks[0]?.y).toBeCloseTo((glyph?.center.y ?? 0) + orbit)
    expect(marks[1]?.x).toBeCloseTo(center_x + Math.SQRT1_2 * orbit)
  })
})

describe('scar mark on a fallback primary', () => {
  it('wears no scar until the terminal failure lands', () => {
    const before = scene_of(fold_fixture(34)).nodes.find(
      (node) => node.glyph.id === 'always_throws',
    )
    expect(before?.status).toBe('active')
    expect(before?.scar).toBeNull()
  })

  it('seats the ember ✕ off the broken puck once the primary scars', () => {
    const session = fold_fixture(events.length)
    const scene = scene_of(session)
    const scarred = scene.nodes.find((node) => node.glyph.id === 'always_throws')
    const glyph = layout(session.structure).nodes.find(
      (node) => node.id === 'always_throws',
    )
    // The artboard-04 seat: up and to the east of the puck centre.
    expect(scarred?.scar).toEqual({
      x: (glyph?.center.x ?? 0) + 14,
      y: (glyph?.center.y ?? 0) - 17,
    })
  })

  it('scars the primary alone, never the backup that carried the run', () => {
    const scene = scene_of(fold_fixture(events.length))
    const scarred = scene.nodes.filter((node) => node.scar !== null)
    expect(scarred.map((node) => node.glyph.id)).toEqual(['always_throws'])
  })
})

describe('runtime metas and view status', () => {
  it('reads RUNNING on the first live leaf', () => {
    const scene = scene_of(fold_fixture(3))
    const metas = new Map(scene.nodes.map((node) => [node.glyph.id, node.meta]))
    expect(metas.get('fetch_brief')).toBe('STEP · RUNNING')
    expect(metas.get('explode_sources')).toBe('STEP')
  })

  it('accretes map cardinality as instances open', () => {
    const scene = scene_of(fold_fixture(11))
    const metas = new Map(scene.nodes.map((node) => [node.glyph.id, node.meta]))
    expect(metas.get('summarize')).toBe('MAP ×2 · RUNNING')
    expect(metas.get('fetch_brief')).toBe('STEP · 42MS')
  })

  it('pins the artboard-01 mid-run canvas: every meta and status', () => {
    const scene = scene_of(fold_fixture(29))
    expect(scene.nodes.map((node) => [node.glyph.id, node.meta, node.status])).toEqual([
      ['fetch_brief', 'STEP · 42MS', 'done'],
      ['explode_sources', 'STEP · 0MS', 'done'],
      ['summarize', 'MAP ×3 · 31MS', 'done'],
      ['score', 'MAP ×3 · 44MS', 'done'],
      ['to_topic', 'STEP · 0MS', 'done'],
      ['flaky_enrich', 'RETRY · ATT 2/3', 'active'],
      ['always_throws', 'STEP · PRIMARY', 'pending'],
      ['safe_default', 'STEP · BACKUP', 'pending'],
      ['finalize', 'TERMINUS', 'pending'],
    ])
    expect(scene.junctions[0]?.status).toBe('done')
  })

  it('settles every meta with its span once the run completes', () => {
    const scene = scene_of(fold_fixture(events.length))
    expect(scene.nodes.map((node) => [node.glyph.id, node.meta, node.status])).toEqual([
      ['fetch_brief', 'STEP · 42MS', 'done'],
      ['explode_sources', 'STEP · 0MS', 'done'],
      ['summarize', 'MAP ×3 · 31MS', 'done'],
      ['score', 'MAP ×3 · 44MS', 'done'],
      ['to_topic', 'STEP · 0MS', 'done'],
      ['flaky_enrich', 'RETRY · ATT 2/3 · 81MS', 'done'],
      ['always_throws', 'STEP · PRIMARY · 16MS', 'failed'],
      ['safe_default', 'STEP · BACKUP · 10MS', 'done'],
      ['finalize', 'TERMINUS · 0MS', 'done'],
    ])
  })

  it('caps the attempt ledger at the configured budget', () => {
    const structure = {
      kind: 'sequence',
      id: 's',
      children: [
        {
          kind: 'retry',
          id: 'r',
          config: { max_attempts: 3 },
          children: [{ kind: 'step', id: 'a' }],
        },
        { kind: 'step', id: 'z' },
      ],
    }
    const session = fold_events(structure, [
      { kind: 'span_start', span_id: 'r1', name: 'retry', id: 'r', ts: 0 },
      { kind: 'span_start', span_id: 'a1', name: 'step', id: 'a', parent_span_id: 'r1', ts: 1 },
      { kind: 'span_end', span_id: 'a1', id: 'a', error: 'x', ts: 2 },
      { kind: 'span_start', span_id: 'a2', name: 'step', id: 'a', parent_span_id: 'r1', ts: 3 },
      { kind: 'span_end', span_id: 'a2', id: 'a', error: 'x', ts: 4 },
      { kind: 'span_start', span_id: 'a3', name: 'step', id: 'a', parent_span_id: 'r1', ts: 5 },
      { kind: 'span_end', span_id: 'a3', id: 'a', error: 'x', ts: 6 },
    ])
    const node = scene_of(session).nodes.find((entry) => entry.glyph.id === 'a')
    expect(node?.meta).toBe('RETRY · ATT 3/3')
    expect(node?.status).toBe('active')
  })

  it('counts attempts without a slash when the budget is unknown', () => {
    const structure = {
      kind: 'sequence',
      id: 's',
      children: [
        { kind: 'retry', id: 'r', children: [{ kind: 'step', id: 'a' }] },
        { kind: 'step', id: 'z' },
      ],
    }
    const session = fold_events(structure, [
      { kind: 'span_start', span_id: 'r1', name: 'retry', id: 'r', ts: 0 },
      { kind: 'span_start', span_id: 'a1', name: 'step', id: 'a', parent_span_id: 'r1', ts: 1 },
    ])
    const node = scene_of(session).nodes.find((entry) => entry.glyph.id === 'a')
    expect(node?.meta).toBe('RETRY · ATT 1')
  })

  it('lets a terminal attempt stay failed once its retry has closed', () => {
    const structure = {
      kind: 'sequence',
      id: 's',
      children: [
        {
          kind: 'retry',
          id: 'r',
          config: { max_attempts: 1 },
          children: [{ kind: 'step', id: 'a' }],
        },
        { kind: 'step', id: 'z' },
      ],
    }
    const session = fold_events(structure, [
      { kind: 'span_start', span_id: 'r1', name: 'retry', id: 'r', ts: 0 },
      { kind: 'span_start', span_id: 'a1', name: 'step', id: 'a', parent_span_id: 'r1', ts: 1 },
      { kind: 'span_end', span_id: 'a1', id: 'a', error: 'x', ts: 2 },
      { kind: 'span_end', span_id: 'r1', id: 'r', error: 'x', ts: 3 },
    ])
    const scene = scene_of(session)
    const node = scene.nodes.find((entry) => entry.glyph.id === 'a')
    expect(node?.status).toBe('failed')
    const states = segment_states(session)
    expect(states.get('loop_upper:r>a')).toBe('traversed')
  })

  it('keeps TERMINUS ahead of the attempt ledger on a terminus leaf', () => {
    const structure = { kind: 'retry', id: 'r', children: [{ kind: 'step', id: 'a' }] }
    const session = fold_events(structure, [
      { kind: 'span_start', span_id: 'r1', name: 'retry', id: 'r', ts: 0 },
      { kind: 'span_start', span_id: 'a1', name: 'step', id: 'a', parent_span_id: 'r1', ts: 1 },
    ])
    const node = scene_of(session).nodes.find((entry) => entry.glyph.id === 'a')
    expect(node?.meta).toBe('TERMINUS · RUNNING')
  })
})

/** One wide-loop body pass opening under the retry span `r1`. */
function pass(span_id: string, ts: number): ReadonlyArray<unknown> {
  return [
    { kind: 'span_start', span_id, name: 'sequence', id: 'body', parent_span_id: 'r1', ts },
  ]
}

describe('the wide loop return lane', () => {
  const structure = {
    kind: 'retry',
    id: 'r',
    children: [
      {
        kind: 'sequence',
        id: 'body',
        children: [
          { kind: 'step', id: 'a' },
          { kind: 'step', id: 'b' },
        ],
      },
    ],
  }
  const open_r = { kind: 'span_start', span_id: 'r1', name: 'retry', id: 'r', ts: 0 }

  it('stays dark through a clean first pass: the subtree is the path', () => {
    const running = fold_events(structure, [open_r, ...pass('s1', 1)])
    expect(segment_states(running).get('loop_return:r>r')).toBe('unbuilt')
    const closed = fold_events(structure, [
      open_r,
      ...pass('s1', 1),
      { kind: 'span_end', span_id: 's1', id: 'body', ts: 2 },
      { kind: 'span_end', span_id: 'r1', id: 'r', ts: 3 },
    ])
    expect(segment_states(closed).get('loop_return:r>r')).toBe('unbuilt')
  })

  it('lights when a repeat is owed and while the repeat runs', () => {
    const failed = fold_events(structure, [
      open_r,
      ...pass('s1', 1),
      { kind: 'span_end', span_id: 's1', id: 'body', error: 'x', ts: 2 },
    ])
    expect(segment_states(failed).get('loop_return:r>r')).toBe('live')
    const repeating = fold_events(structure, [
      open_r,
      ...pass('s1', 1),
      { kind: 'span_end', span_id: 's1', id: 'body', error: 'x', ts: 2 },
      ...pass('s2', 3),
    ])
    expect(segment_states(repeating).get('loop_return:r>r')).toBe('live')
  })

  it('earns grey once a repeat actually happened and the loop closed', () => {
    const session = fold_events(structure, [
      open_r,
      ...pass('s1', 1),
      { kind: 'span_end', span_id: 's1', id: 'body', error: 'x', ts: 2 },
      ...pass('s2', 3),
      { kind: 'span_end', span_id: 's2', id: 'body', ts: 4 },
      { kind: 'span_end', span_id: 'r1', id: 'r', ts: 5 },
    ])
    expect(segment_states(session).get('loop_return:r>r')).toBe('traversed')
  })
})

describe('group label runtime', () => {
  it('reads the artboard-01 line mid-run: span, plain, armed', () => {
    expect(
      scene_of(fold_fixture(29)).group_labels.map((label) => [
        label.anchor.owner,
        label.text,
      ]),
    ).toEqual([
      ['parallel_1', 'PARALLEL_1 · 45MS'],
      ['retry_1', 'RETRY_1'],
      ['fallback_1', 'FALLBACK_1 · ARMED'],
    ])
  })

  it('settles every group with its span once the run completes', () => {
    expect(
      scene_of(fold_fixture(events.length)).group_labels.map((label) => label.text),
    ).toEqual(['PARALLEL_1 · 45MS', 'RETRY_1 · 81MS', 'FALLBACK_1 · 27MS'])
  })

  it('stays plain while any occurrence still runs, even after a settled one', () => {
    const structure = {
      kind: 'parallel',
      id: 'p',
      children: [
        { kind: 'step', id: 'a' },
        { kind: 'step', id: 'b' },
      ],
    }
    const session = fold_events(structure, [
      { kind: 'span_start', span_id: 'p1', name: 'parallel', id: 'p', ts: 0 },
      { kind: 'span_end', span_id: 'p1', id: 'p', ts: 10 },
      { kind: 'span_start', span_id: 'p2', name: 'parallel', id: 'p', ts: 20 },
    ])
    expect(scene_of(session).group_labels[0]?.text).toBe('P')
  })
})

describe('the treatment radii', () => {
  it('carries the artboard halo and bloom sizes', () => {
    expect(HALO_RADIUS).toBe(40)
    expect(BLOOM_RADIUS).toBe(215)
  })
})

/** Fold a whole trajectory (structure line first) into a session. */
function fold_all(frames: ReadonlyArray<unknown>): Session {
  let session = EMPTY_SESSION
  for (const frame of frames) session = apply_frame(session, frame)
  return session
}

/** The scene lane and its reserved geometry for one map owner. */
function lane_of(
  session: Session,
  owner: string,
): { readonly scene: SceneTickLane; readonly x0: number; readonly y: number; readonly length: number } {
  const scene = scene_of(session).tick_lanes.find((lane) => lane.owner === owner)
  const geom = layout(session.structure).tick_lanes.find((lane) => lane.owner === owner)
  if (scene === undefined || geom === undefined) throw new Error(`no lane for ${owner}`)
  return { scene, x0: geom.x0, y: geom.y, length: geom.x1 - geom.x0 }
}

/** The meta parts of one node id. */
function meta_of(session: Session, id: string): { text: string; fail: string | null } {
  const node = scene_of(session).nodes.find((entry) => entry.glyph.id === id)
  if (node === undefined) throw new Error(`no node ${id}`)
  return { text: node.meta, fail: node.meta_fail }
}

describe('map instance ticks (artboard 03)', () => {
  it('draws no ticks before an instance opens, and the fixture maps at T+0', () => {
    const scene = scene_of(fold_fixture(1))
    expect(scene.tick_lanes.map((lane) => lane.owner)).toEqual(['map_1', 'map_2'])
    for (const lane of scene.tick_lanes) {
      expect(lane.ticks).toEqual([])
      expect(lane.decades).toEqual([])
    }
  })

  it('sits a small cohort at the canvas pitch, grey once every instance is done', () => {
    const session = fold_all(map_trajectory({ count: 3 }))
    const { scene, x0, y, length } = lane_of(session, 'map_1')
    expect(scene.ticks.map((tick) => tick.status)).toEqual(['done', 'done', 'done'])
    // The x3 idiom: pitch 30 off the lane start, on the lane line, no squeeze.
    expect(length).toBe(88)
    expect(scene.ticks.map((tick) => tick.x - x0)).toEqual([0, 30, 60])
    expect(scene.ticks.every((tick) => tick.y === y)).toBe(true)
    expect(scene.decades).toEqual([])
    expect(meta_of(session, 'summarize').text).toMatch(/^MAP ×3 · \d+MS$/)
    expect(meta_of(session, 'summarize').fail).toBeNull()
  })

  it('omits the ×count for a single instance', () => {
    const session = fold_all(map_trajectory({ count: 1 }))
    expect(lane_of(session, 'map_1').scene.ticks.map((tick) => tick.status)).toEqual(['done'])
    expect(meta_of(session, 'summarize').text).toMatch(/^MAP · \d+MS$/)
  })

  it('marches the still-open instances amber as the fixture map opens', () => {
    const map1 = scene_of(fold_fixture(11)).tick_lanes.find((lane) => lane.owner === 'map_1')
    expect(map1?.ticks.map((tick) => tick.status)).toEqual(['live', 'live'])
  })

  it('switches to the ruler comb past a decade and keeps a failure as its ✕ slot', () => {
    const session = fold_all(map_trajectory({ count: 12, failed: [4] }))
    const { scene, x0, length } = lane_of(session, 'map_1')
    expect(scene.ticks).toHaveLength(12)
    expect(scene.ticks[4]?.status).toBe('failed')
    expect(scene.ticks.filter((tick) => tick.status === 'failed')).toHaveLength(1)
    expect(scene.ticks.filter((tick) => tick.status === 'done')).toHaveLength(11)
    // One decade numeral, at value 10, squeezed with the comb into the lane.
    expect(scene.decades.map((decade) => decade.value)).toEqual([10])
    expect(scene.decades[0]?.x).toBeCloseTo(x0 + 175 * (length / 206))
    expect(scene.decades[0]?.y).toBe(lane_of(session, 'map_1').y + 30)
    // A failure surfaces as its ember ✕ tally, replacing the duration.
    expect(meta_of(session, 'summarize')).toEqual({ text: 'MAP ×12', fail: '1 ✕' })
  })

  it('lights only the running window amber, keeps every failure slot, at x50', () => {
    const session = fold_all(map_trajectory({ count: 50, failed: [8, 16, 27], live: 8 }))
    const { scene } = lane_of(session, 'map_1')
    expect(scene.ticks).toHaveLength(50)
    const live = scene.ticks.flatMap((tick, index) => (tick.status === 'live' ? [index] : []))
    const failed = scene.ticks.flatMap((tick, index) => (tick.status === 'failed' ? [index] : []))
    expect(live).toEqual([42, 43, 44, 45, 46, 47, 48, 49])
    expect(failed).toEqual([8, 16, 27])
    expect(scene.ticks.filter((tick) => tick.status === 'done')).toHaveLength(39)
    expect(scene.decades.map((decade) => decade.value)).toEqual([10, 20, 30, 40, 50])
    expect(meta_of(session, 'summarize')).toEqual({ text: 'MAP ×50 · 8 LIVE', fail: '3 ✕' })
  })

  it('keeps a small running map on the plain RUNNING clause', () => {
    const session = fold_all(map_trajectory({ count: 3, live: 2 }))
    expect(lane_of(session, 'map_1').scene.ticks.map((tick) => tick.status)).toEqual([
      'done',
      'live',
      'live',
    ])
    expect(meta_of(session, 'summarize')).toEqual({ text: 'MAP ×3 · RUNNING', fail: null })
  })

  it('surfaces a failure even on a small completed map, over the duration', () => {
    const session = fold_all(map_trajectory({ count: 3, failed: [1] }))
    expect(lane_of(session, 'map_1').scene.ticks.map((tick) => tick.status)).toEqual([
      'done',
      'failed',
      'done',
    ])
    expect(meta_of(session, 'summarize')).toEqual({ text: 'MAP ×3', fail: '1 ✕' })
  })

  it('reads the live-window count once a clean map runs at scale', () => {
    const session = fold_all(map_trajectory({ count: 12, live: 5 }))
    expect(meta_of(session, 'summarize')).toEqual({ text: 'MAP ×12 · 5 LIVE', fail: null })
  })

  it('gives the finished fixture maps their x3 fan of grey ticks', () => {
    const lanes = new Map(
      scene_of(fold_fixture(events.length)).tick_lanes.map((lane) => [lane.owner, lane]),
    )
    expect(lanes.get('map_1')?.ticks.map((tick) => tick.status)).toEqual([
      'done',
      'done',
      'done',
    ])
    expect(lanes.get('map_2')?.ticks.map((tick) => tick.status)).toEqual([
      'done',
      'done',
      'done',
    ])
    expect(lanes.get('map_1')?.decades).toEqual([])
  })

  it('draws no ticks for a map lane the session does not know', () => {
    const foreign = layout({ kind: 'map', id: 'm', children: [{ kind: 'step', id: 'x' }] })
    const scene = build_scene(foreign, EMPTY_SESSION)
    expect(scene.tick_lanes.find((lane) => lane.owner === 'm')?.ticks).toEqual([])
  })

  it('draws no ticks for a known map with no body, without crashing (C7)', () => {
    const session = apply_frame(EMPTY_SESSION, {
      kind: 'flow_structure',
      structure: { kind: 'map', id: 'm' },
    })
    expect(scene_of(session).tick_lanes.find((lane) => lane.owner === 'm')?.ticks).toEqual([])
  })

  it('keeps a running map at the decade boundary on the plain clause', () => {
    const session = fold_all(map_trajectory({ count: 10, live: 10 }))
    // Ten is the last count at the canvas pitch (the comb is count > 10), so the
    // meta stays RUNNING rather than the at-scale live window.
    expect(meta_of(session, 'summarize')).toEqual({ text: 'MAP ×10 · RUNNING', fail: null })
    const session_11 = fold_all(map_trajectory({ count: 11, live: 11 }))
    expect(meta_of(session_11, 'summarize')).toEqual({ text: 'MAP ×11 · 11 LIVE', fail: null })
  })

  it('keeps a failed instance in the tick lane, off the collapsed map puck', () => {
    const session = fold_all(map_trajectory({ count: 12, failed: [4] }))
    // The fold still records the permanent failure and counts it in the header.
    expect(session.state.nodes.get('summarize')?.scarred).toBe(true)
    expect(session.state.scars).toBe(1)
    // But the collapsed puck stays whole: the ✕ lives in the tick lane instead.
    const summarize = scene_of(session).nodes.find((node) => node.glyph.id === 'summarize')
    expect(summarize?.scar).toBeNull()
    expect(lane_of(session, 'map_1').scene.ticks[4]?.status).toBe('failed')
  })
})

/** The scene node for one id, throwing when the glyph is missing. */
function scene_node(session: Session, id: string): ReturnType<typeof build_scene>['nodes'][number] {
  const node = scene_of(session).nodes.find((entry) => entry.glyph.id === id)
  if (node === undefined) throw new Error(`no node ${id}`)
  return node
}

describe('suspended treatment (Q1)', () => {
  const GATED = {
    kind: 'sequence',
    id: 'seq',
    children: [
      { kind: 'suspend', id: 'gate' },
      { kind: 'step', id: 'after' },
    ],
  }
  const parked = [
    { kind: 'span_start', span_id: 's0', name: 'sequence', id: 'seq', ts: 1 },
    { kind: 'span_start', span_id: 'g1', name: 'suspend', id: 'gate', parent_span_id: 's0', ts: 2 },
    { kind: 'suspended', suspend_id: 'gate', step_id: 'gate', ts: 3 },
  ]
  const settled = [
    ...parked,
    { kind: 'span_end', span_id: 'g1', id: 'gate', error: 'suspended: gate', ts: 4 },
    { kind: 'span_end', span_id: 's0', id: 'seq', error: 'suspended: gate', ts: 5 },
    { kind: 'run_end', status: 'suspended', ts: 5 },
  ]

  it('trades the whole meta line for SUSPENDED', () => {
    const node = scene_node(fold_events(GATED, settled), 'gate')
    expect(node.meta).toBe('SUSPENDED')
    expect(node.status).toBe('suspended')
  })

  it('parks the light: the approach greys the moment the suspension lands', () => {
    // The suspend span is still open here; without the parked rule the entry
    // would march amber while the run is going nowhere.
    const states = segment_states(fold_events(GATED, parked))
    expect(states.get('entry:·>seq')).toBe('traversed')
    expect(states.get('line:gate>after')).toBe('unbuilt')
    const after = segment_states(fold_events(GATED, settled))
    expect(after.get('entry:·>seq')).toBe('traversed')
    expect(after.get('line:gate>after')).toBe('unbuilt')
  })

  it('returns to the ordinary grammar when the node resumes', () => {
    const resumed = fold_events(GATED, [
      ...settled,
      { kind: 'span_start', span_id: 'g2', name: 'suspend', id: 'gate', ts: 100 },
    ])
    const node = scene_node(resumed, 'gate')
    // ×2 is the ordinary repeat grammar being honest: the gate ran twice.
    expect(node.meta).toBe('SUSPEND ×2 · RUNNING')
    expect(node.status).toBe('active')
    expect(scene_of(resumed).cards).toEqual([])
  })
})

describe('the checkpoint tick', () => {
  const CACHED = {
    kind: 'sequence',
    id: 'seq',
    children: [
      { kind: 'checkpoint', id: 'cp', children: [{ kind: 'step', id: 'inner' }] },
      { kind: 'step', id: 'z' },
    ],
  }

  it('marks the node a hit spared, and only a hit', () => {
    const hit = fold_events(CACHED, [{ kind: 'checkpoint', status: 'hit', id: 'cp', ts: 1 }])
    expect(scene_node(hit, 'inner').checkpoint).toBe(true)
    expect(scene_node(hit, 'z').checkpoint).toBe(false)
    const miss = fold_events(CACHED, [{ kind: 'checkpoint', status: 'miss', id: 'cp', ts: 1 }])
    expect(scene_node(miss, 'inner').checkpoint).toBe(false)
  })

  it('seats the tick on the first leaf of a wide checkpoint body', () => {
    const wide = {
      kind: 'checkpoint',
      id: 'cp',
      children: [
        {
          kind: 'sequence',
          id: 'body',
          children: [
            { kind: 'step', id: 'a' },
            { kind: 'step', id: 'b' },
          ],
        },
      ],
    }
    const session = fold_events(wide, [{ kind: 'checkpoint', status: 'hit', id: 'cp', ts: 1 }])
    expect(scene_node(session, 'a').checkpoint).toBe(true)
    expect(scene_node(session, 'b').checkpoint).toBe(false)
  })

  it('wears the tick on its own puck when the wrapper has no body (C7)', () => {
    const bare = {
      kind: 'sequence',
      id: 'seq',
      children: [
        { kind: 'checkpoint', id: 'cp' },
        { kind: 'step', id: 'z' },
      ],
    }
    const session = fold_events(bare, [{ kind: 'checkpoint', status: 'hit', id: 'cp', ts: 1 }])
    expect(scene_node(session, 'cp').checkpoint).toBe(true)
  })
})

describe('annotation cards (Q4)', () => {
  it('shows no card at T+0 or through a first attempt in flight', () => {
    expect(scene_of(fold_fixture(1)).cards).toEqual([])
    expect(scene_of(fold_fixture(28)).cards).toEqual([])
  })

  it('raises the artboard-01 card while attempt 2 is in flight', () => {
    const cards = scene_of(fold_fixture(29)).cards
    expect(cards).toHaveLength(1)
    expect(cards[0]?.owner).toBe('flaky_enrich')
    expect(
      cards[0]?.lines.map((line) => [
        line.role,
        line.spans.map((span) => span.text).join(''),
      ]),
    ).toEqual([
      ['title', 'ATTEMPT 2 OF 3'],
      ['detail', 'ATT 1 ✕ TRANSIENT UPSTREAM ERROR'],
      ['detail', 'BACKOFF 25MS HONORED'],
    ])
    // Ember wraps the ✕ alone, never the words around it (C4).
    expect(cards[0]?.lines[1]?.spans).toEqual([
      { text: 'ATT 1 ', ember: false },
      { text: '✕', ember: true },
      { text: ' TRANSIENT UPSTREAM ERROR', ember: false },
    ])
  })

  it('keeps the card through the second attempt and dismisses it on resolve', () => {
    expect(scene_of(fold_fixture(30)).cards).toHaveLength(1)
    expect(scene_of(fold_fixture(31)).cards).toEqual([])
  })

  it('seats the block at the artboard offsets with the dot on the halo edge', () => {
    const session = fold_fixture(29)
    const card = scene_of(session).cards[0]
    if (card === undefined) throw new Error('no card at the artboard-01 moment')
    const glyph = layout(session.structure).nodes.find((node) => node.id === 'flaky_enrich')
    const cx = glyph?.center.x ?? 0
    const cy = glyph?.center.y ?? 0
    expect(card.lines.map((line) => [line.x, line.y])).toEqual([
      [cx - 156, cy - 279],
      [cx - 156, cy - 257],
      [cx - 156, cy - 235],
    ])
    // The leader leaves the block's bottom on the side facing the node...
    expect(card.leader).toBe(
      `M ${cx - 156 + 112} ${cy - 235 + 14} L ${card.dot.x} ${card.dot.y}`,
    )
    // ...and the dot sits exactly on the halo circle, above the puck.
    expect(Math.hypot(card.dot.x - cx, card.dot.y - cy)).toBeCloseTo(HALO_RADIUS)
    expect(card.dot.y).toBeLessThan(cy)
  })

  it('mirrors to the up-right seat when the puck sits too far west', () => {
    const session = fold_events(
      {
        kind: 'sequence',
        id: 'seq',
        children: [
          { kind: 'suspend', id: 'gate' },
          { kind: 'step', id: 'after' },
        ],
      },
      [
        { kind: 'span_start', span_id: 's0', name: 'sequence', id: 'seq', ts: 1 },
        { kind: 'span_start', span_id: 'g1', name: 'suspend', id: 'gate', parent_span_id: 's0', ts: 2 },
        { kind: 'suspended', suspend_id: 'gate', step_id: 'gate', ts: 3 },
      ],
    )
    const card = scene_of(session).cards[0]
    const glyph = layout(session.structure).nodes.find((node) => node.id === 'gate')
    const cx = glyph?.center.x ?? 0
    expect(card?.lines[0]?.x).toBe(cx + 44)
    expect(card?.leader.startsWith(`M ${cx + 44 + 12} `)).toBe(true)
  })

  it('persists the scar card and speaks its error, one card on the canvas', () => {
    const cards = scene_of(fold_fixture(events.length)).cards
    expect(cards).toHaveLength(1)
    expect(cards[0]?.owner).toBe('always_throws')
    expect(
      cards[0]?.lines.map((line) => [
        line.role,
        line.spans.map((span) => span.text).join(''),
      ]),
    ).toEqual([
      ['title', 'PERMANENT FAILURE'],
      ['detail', '✕ PRIMARY PATH UNAVAILABLE'],
    ])
  })

  it('switches an exhausted retry to the scar card once the loop dies', () => {
    const session = fold_events(
      {
        kind: 'sequence',
        id: 'seq',
        children: [
          {
            kind: 'retry',
            id: 'r',
            config: { max_attempts: 2 },
            children: [{ kind: 'step', id: 'a' }],
          },
          { kind: 'step', id: 'z' },
        ],
      },
      [
        { kind: 'span_start', span_id: 's0', name: 'sequence', id: 'seq', ts: 0 },
        { kind: 'span_start', span_id: 'r1', name: 'retry', id: 'r', parent_span_id: 's0', ts: 1 },
        { kind: 'span_start', span_id: 'a1', name: 'step', id: 'a', parent_span_id: 'r1', ts: 2 },
        { kind: 'span_end', span_id: 'a1', id: 'a', error: 'boom', ts: 3 },
        { kind: 'span_start', span_id: 'a2', name: 'step', id: 'a', parent_span_id: 'r1', ts: 4 },
        { kind: 'span_end', span_id: 'a2', id: 'a', error: 'boom', ts: 5 },
        { kind: 'span_end', span_id: 'r1', id: 'r', error: 'boom', ts: 6 },
      ],
    )
    const cards = scene_of(session).cards
    expect(cards).toHaveLength(1)
    expect(cards[0]?.lines[0]?.spans[0]?.text).toBe('PERMANENT FAILURE')
  })

  it('keeps a map child in its tick lane: no card over the collapsed puck', () => {
    const session = fold_all(map_trajectory({ count: 12, failed: [4] }))
    expect(scene_of(session).cards).toEqual([])
  })

  it('caps a long error clause so a card stays a card', () => {
    const session = fold_events(
      {
        kind: 'sequence',
        id: 'seq',
        children: [
          { kind: 'step', id: 'a' },
          { kind: 'step', id: 'z' },
        ],
      },
      [
        { kind: 'span_start', span_id: 's0', name: 'sequence', id: 'seq', ts: 0 },
        { kind: 'span_start', span_id: 'a1', name: 'step', id: 'a', parent_span_id: 's0', ts: 1 },
        { kind: 'span_end', span_id: 'a1', id: 'a', error: 'x'.repeat(40), ts: 2 },
      ],
    )
    const detail = scene_of(session).cards[0]?.lines[1]?.spans
    expect(detail?.[1]?.text).toBe(` ${'X'.repeat(23)}…`)
  })

  it('leaves a bare unbudgeted retry card to count without a slash', () => {
    const session = fold_events(
      {
        kind: 'sequence',
        id: 'seq',
        children: [
          { kind: 'retry', id: 'r', children: [{ kind: 'step', id: 'a' }] },
          { kind: 'step', id: 'z' },
        ],
      },
      [
        { kind: 'span_start', span_id: 'r1', name: 'retry', id: 'r', ts: 0 },
        { kind: 'span_start', span_id: 'a1', name: 'step', id: 'a', parent_span_id: 'r1', ts: 1 },
        { kind: 'span_end', span_id: 'a1', id: 'a', error: 'nope', ts: 2 },
      ],
    )
    const card = scene_of(session).cards[0]
    expect(card?.lines.map((line) => line.spans.map((span) => span.text).join(''))).toEqual([
      'ATTEMPT 2',
      'ATT 1 ✕ NOPE',
    ])
  })
})

describe('the treatments fixture', () => {
  it('folds to the suspended study the Playwright baseline pins', () => {
    const session = fold_all(treatments_trajectory())
    expect(scene_node(session, 'warm_up').meta).toBe('STEP · 12MS')
    const spared = scene_node(session, 'expensive_brief')
    expect(spared.meta).toBe('STEP')
    expect(spared.status).toBe('pending')
    expect(spared.checkpoint).toBe(true)
    const emitter = scene_node(session, 'gather')
    expect(emitter.emits).toBe(2)
    expect(emitter.meta).toBe('STEP · 53MS')
    const parked = scene_node(session, 'await_approval')
    expect(parked.meta).toBe('SUSPENDED')
    expect(parked.status).toBe('suspended')
    expect(scene_node(session, 'publish').status).toBe('pending')

    const cards = scene_of(session).cards
    expect(cards).toHaveLength(1)
    expect(cards[0]?.owner).toBe('await_approval')
    expect(
      cards[0]?.lines.map((line) => line.spans.map((span) => span.text).join('')),
    ).toEqual(['SUSPENDED', 'AWAITING RESUME'])

    const states = segment_states(session)
    expect(states.get('line:gather>await_approval')).toBe('traversed')
    expect(states.get('line:await_approval>publish')).toBe('unbuilt')
  })

  it('has one bloom just landed at the emit cut', () => {
    const session = fold_all(treatments_trajectory().slice(0, TREATMENTS_EMIT_CUT))
    const emitter = scene_node(session, 'gather')
    expect(emitter.emits).toBe(1)
    expect(emitter.status).toBe('active')
  })
})
