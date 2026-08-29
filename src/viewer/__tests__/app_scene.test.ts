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
} from '../app/lib/scene.js'

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

  it('leaves every line traversed once the run is done', () => {
    const states = segment_states(fold_fixture(events.length))
    expect(states.size).toBe(18)
    expect(new Set(states.values())).toEqual(new Set(['traversed']))
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
