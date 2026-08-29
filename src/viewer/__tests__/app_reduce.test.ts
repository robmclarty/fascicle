/**
 * The canvas fold: reduce(structure, events[0..t]) and its incremental form.
 *
 * The design fixture drives the reference expectations (the same run the
 * artboards freeze), synthetic streams pin the failure semantics the fixture
 * never reaches (retry exhaustion, nested absorption, engine-origin scars,
 * suspension), and the property test holds the purity contract: a fresh fold
 * of any prefix equals incremental application with retained snapshots (C5).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { FlowNode } from '#core'
import {
  apply_event,
  initial_state,
  reduce,
  t_plus_ms,
  type CanvasState,
  type NodeRuntime,
} from '../app/lib/reduce.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const fixture: unknown[] = readFileSync(
  join(HERE, 'fixtures', 'fixture.trajectory.jsonl'),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as unknown)

const structure = (fixture[0] as { structure: FlowNode }).structure

const FIXTURE_RUN_ID = '42b20e54-41e6-47b2-8697-bda677867762'
const STRUCTURE_IDS = [
  'sequence_1',
  'fetch_brief',
  'explode_sources',
  'parallel_1',
  'map_1',
  'summarize',
  'map_2',
  'score',
  'to_topic',
  'retry_1',
  'flaky_enrich',
  'fallback_1',
  'always_throws',
  'safe_default',
  'finalize',
]

/** The fixture prefix ending on flaky_enrich's failed first attempt. */
const MID_RUN = 29

function node_of(state: CanvasState, id: string): NodeRuntime {
  const node = state.nodes.get(id)
  if (node === undefined) throw new Error(`no node ${id} in state`)
  return node
}

function statuses(state: CanvasState): Record<string, string> {
  return Object.fromEntries([...state.nodes].map(([id, node]) => [id, node.status]))
}

function scarred_ids(state: CanvasState): string[] {
  return [...state.nodes].filter(([, node]) => node.scarred).map(([id]) => id)
}

/** Stamp run_id and a strictly increasing ts onto synthetic event rows. */
function stream(rows: ReadonlyArray<Record<string, unknown>>): unknown[] {
  return rows.map((row, index) => ({ run_id: 'r', ts: 1000 + index, ...row }))
}

function start(
  span_id: string,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind: 'span_start', span_id, name, ...extra }
}

function end(span_id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'span_end', span_id, ...extra }
}

describe('initial_state and the T+0 fold', () => {
  it('pre-seeds every structure node as pending with nothing known', () => {
    const state = reduce(structure, fixture.slice(0, 1))
    expect([...state.nodes.keys()].toSorted()).toEqual([...STRUCTURE_IDS].toSorted())
    for (const id of STRUCTURE_IDS) {
      expect(node_of(state, id)).toEqual({
        status: 'pending',
        occurrences: [],
        scarred: false,
        suspended: false,
        turn_retries: 0,
        cost_usd: 0,
        emits: 0,
        checkpoint: null,
      })
    }
  })

  it('names the run and starts the clock from the structure event alone', () => {
    const state = reduce(structure, fixture.slice(0, 1))
    expect(state.run_id).toBe(FIXTURE_RUN_ID)
    expect(t_plus_ms(state)).toBe(0)
    expect(state.retries_absorbed).toBe(0)
    expect(state.scars).toBe(0)
    expect(state.cost_usd).toBe(0)
    expect(state.run_status).toBeNull()
  })

  it('keeps the kind index from the structure tree', () => {
    const state = initial_state(structure)
    expect(state.kinds.get('retry_1')).toBe('retry')
    expect(state.kinds.get('map_1')).toBe('map')
    expect(state.kinds.get('fallback_1')).toBe('fallback')
    expect(state.kinds.get('flaky_enrich')).toBe('step')
  })

  it('keeps the first kind seen for a repeated structure id', () => {
    // A <cycle> back-reference repeats the id of the node it points at; the
    // real node's kind must win regardless of walk order.
    const state = initial_state({
      kind: 'sequence',
      id: 'root',
      children: [
        { kind: 'step', id: 'x' },
        { kind: '<cycle>', id: 'x' },
      ],
    })
    expect(state.kinds.get('x')).toBe('step')
    expect(state.nodes.size).toBe(2)
  })

  it('folds without a structure at all', () => {
    const state = reduce(null, fixture.slice(1))
    expect(node_of(state, 'flaky_enrich').occurrences).toHaveLength(2)
    expect(state.retries_absorbed).toBe(1)
    expect(state.run_status).toBe('done')
  })
})

describe('the fixture mid-run fold', () => {
  // Folded inside each test, not at describe scope: module-load work runs
  // before Stryker activates a mutant, so a shared fold would assert against
  // unmutated state and the whole block would stop killing anything.
  const fold = () => reduce(structure, fixture.slice(0, MID_RUN))

  it('has the retry live on a spent first attempt', () => {
    expect(statuses(fold())).toEqual({
      sequence_1: 'active',
      fetch_brief: 'done',
      explode_sources: 'done',
      parallel_1: 'done',
      map_1: 'done',
      summarize: 'done',
      map_2: 'done',
      score: 'done',
      to_topic: 'done',
      retry_1: 'active',
      flaky_enrich: 'failed',
      fallback_1: 'pending',
      always_throws: 'pending',
      safe_default: 'pending',
      finalize: 'pending',
    })
  })

  it('counts the caught attempt as absorbed, with no scar', () => {
    const state = fold()
    expect(state.retries_absorbed).toBe(1)
    expect(state.scars).toBe(0)
    expect(scarred_ids(state)).toEqual([])
  })

  it('keeps the failed attempt with its error and span parent', () => {
    const attempts = node_of(fold(), 'flaky_enrich').occurrences
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      status: 'failed',
      error: 'transient upstream error',
      parent_span_id: 'retry:c30c0755',
    })
  })

  it('reads T+113 at the failure event, the fold clock not a wall clock', () => {
    expect(t_plus_ms(fold())).toBe(113)
  })
})

describe('the fixture full fold', () => {
  // Same in-test folding as the mid-run block, for the same Stryker reason.
  const fold = () => reduce(structure, fixture)

  it('resolves every node, with the dead fallback primary the one failure', () => {
    expect(statuses(fold())).toEqual({
      sequence_1: 'done',
      fetch_brief: 'done',
      explode_sources: 'done',
      parallel_1: 'done',
      map_1: 'done',
      summarize: 'done',
      map_2: 'done',
      score: 'done',
      to_topic: 'done',
      retry_1: 'done',
      flaky_enrich: 'done',
      fallback_1: 'done',
      always_throws: 'failed',
      safe_default: 'done',
      finalize: 'done',
    })
  })

  it('scars exactly the fallback primary', () => {
    const state = fold()
    expect(scarred_ids(state)).toEqual(['always_throws'])
    expect(state.scars).toBe(1)
  })

  it('groups map instances by their parent span (D6)', () => {
    const state = fold()
    const instances = node_of(state, 'summarize').occurrences
    expect(instances).toHaveLength(3)
    for (const instance of instances) {
      expect(instance.parent_span_id).toBe('map:22f50644')
      expect(instance.status).toBe('done')
    }
    expect(node_of(state, 'score').occurrences).toHaveLength(3)
  })

  it('groups retry attempts by their parent span, failure then success (D6)', () => {
    const attempts = node_of(fold(), 'flaky_enrich').occurrences
    expect(attempts.map((attempt) => attempt.status)).toEqual(['failed', 'done'])
    expect(attempts.map((attempt) => attempt.parent_span_id)).toEqual([
      'retry:c30c0755',
      'retry:c30c0755',
    ])
  })

  it('lands the header numbers for the finished run', () => {
    const state = fold()
    expect(state.retries_absorbed).toBe(1)
    expect(state.scars).toBe(1)
    expect(state.cost_usd).toBe(0)
    expect(state.unattributed_usd).toBe(0)
    expect(state.run_status).toBe('done')
    expect(t_plus_ms(state)).toBe(196)
  })

  it('creates no stray nodes and closes every span', () => {
    const state = fold()
    expect([...state.nodes.keys()].toSorted()).toEqual([...STRUCTURE_IDS].toSorted())
    expect(state.open_spans).toEqual([])
    for (const span of state.spans.values()) expect(span.open).toBe(false)
  })
})

describe('the purity contract (C5)', () => {
  it('folds any prefix fresh to the state incremental application reached', () => {
    let state = initial_state(structure)
    const snapshots: CanvasState[] = [state]
    for (const event of fixture) {
      state = apply_event(state, event)
      snapshots.push(state)
    }
    for (let t = 0; t <= fixture.length; t += 1) {
      expect(snapshots[t]).toEqual(reduce(structure, fixture.slice(0, t)))
    }
  })

  it('never reads the wall clock', () => {
    const now = vi.spyOn(Date, 'now')
    try {
      reduce(structure, fixture)
      expect(now).not.toHaveBeenCalled()
    } finally {
      now.mockRestore()
    }
  })
})

describe('retry semantics (D12)', () => {
  const RETRY_FLOW: FlowNode = {
    kind: 'retry',
    id: 'retry_x',
    children: [{ kind: 'step', id: 'unlucky' }],
  }

  it('converts the final absorbed attempt to a scar when the retry exhausts', () => {
    // The never-run sibling keeps an occurrence-less node in the map while
    // the exhaustion scan walks it, which is exactly where a scan that
    // assumes occurrences exist would crash.
    const ROOT: FlowNode = {
      kind: 'sequence',
      id: 'root',
      children: [RETRY_FLOW, { kind: 'step', id: 'never_ran' }],
    }
    const state = reduce(
      ROOT,
      stream([
        start('r1', 'retry', { id: 'retry_x' }),
        start('a1', 'step', { id: 'unlucky', parent_span_id: 'r1' }),
        end('a1', { id: 'unlucky', error: 'boom' }),
        start('a2', 'step', { id: 'unlucky', parent_span_id: 'r1' }),
        end('a2', { id: 'unlucky', error: 'boom' }),
        start('a3', 'step', { id: 'unlucky', parent_span_id: 'r1' }),
        end('a3', { id: 'unlucky', error: 'boom' }),
        end('r1', { id: 'retry_x', error: 'boom' }),
        { kind: 'run_end', status: 'failed' },
      ]),
    )
    expect(state.retries_absorbed).toBe(2)
    expect(state.scars).toBe(1)
    expect(scarred_ids(state)).toEqual(['unlucky'])
    expect(node_of(state, 'unlucky').status).toBe('failed')
    expect(node_of(state, 'retry_x').scarred).toBe(false)
    expect(state.run_status).toBe('failed')
  })

  it('scars the retry itself when it dies without a failed attempt on record', () => {
    const state = reduce(
      RETRY_FLOW,
      stream([
        start('r1', 'retry', { id: 'retry_x' }),
        end('r1', { id: 'retry_x', error: 'aborted before first attempt' }),
      ]),
    )
    expect(scarred_ids(state)).toEqual(['retry_x'])
    expect(state.scars).toBe(1)
    expect(state.retries_absorbed).toBe(0)
  })

  it('scars a failure whose parent chain breaks before reaching any retry', () => {
    const state = reduce(
      null,
      stream([
        start('w1', 'step', { id: 'work', parent_span_id: 'ghost' }),
        end('w1', { id: 'work', error: 'boom' }),
      ]),
    )
    expect(scarred_ids(state)).toEqual(['work'])
    expect(state.retries_absorbed).toBe(0)
  })

  it('does not let an already-closed retry absorb a straggler failure', () => {
    const state = reduce(
      RETRY_FLOW,
      stream([
        start('r1', 'retry', { id: 'retry_x' }),
        start('a1', 'step', { id: 'unlucky', parent_span_id: 'r1' }),
        end('r1', { id: 'retry_x' }),
        end('a1', { id: 'unlucky', error: 'late boom' }),
      ]),
    )
    expect(state.retries_absorbed).toBe(0)
    expect(scarred_ids(state)).toEqual(['unlucky'])
  })

  it('absorbs a failure that reaches the retry through a nested combinator', () => {
    const NESTED: FlowNode = {
      kind: 'retry',
      id: 'retry_x',
      children: [
        { kind: 'timeout', id: 'timeout_x', children: [{ kind: 'step', id: 'work' }] },
      ],
    }
    const state = reduce(
      NESTED,
      stream([
        start('r1', 'retry', { id: 'retry_x' }),
        start('t1', 'timeout', { id: 'timeout_x', parent_span_id: 'r1' }),
        start('w1', 'step', { id: 'work', parent_span_id: 't1' }),
        end('w1', { id: 'work', error: 'slow' }),
        end('t1', { id: 'timeout_x', error: 'slow' }),
        start('t2', 'timeout', { id: 'timeout_x', parent_span_id: 'r1' }),
        start('w2', 'step', { id: 'work', parent_span_id: 't2' }),
        end('w2', { id: 'work' }),
        end('t2', { id: 'timeout_x' }),
        end('r1', { id: 'retry_x' }),
      ]),
    )
    expect(state.retries_absorbed).toBe(1)
    expect(state.scars).toBe(0)
    expect(statuses(state)).toEqual({ retry_x: 'done', timeout_x: 'done', work: 'done' })
  })

  it('leaves an inner exhaustion unscarred while an outer retry can re-run it', () => {
    const DOUBLE: FlowNode = {
      kind: 'retry',
      id: 'outer',
      children: [
        { kind: 'retry', id: 'inner', children: [{ kind: 'step', id: 'work' }] },
      ],
    }
    const state = reduce(
      DOUBLE,
      stream([
        start('o1', 'retry', { id: 'outer' }),
        start('i1', 'retry', { id: 'inner', parent_span_id: 'o1' }),
        start('a1', 'step', { id: 'work', parent_span_id: 'i1' }),
        end('a1', { id: 'work', error: 'boom' }),
        end('i1', { id: 'inner', error: 'boom' }),
        start('i2', 'retry', { id: 'inner', parent_span_id: 'o1' }),
        start('a2', 'step', { id: 'work', parent_span_id: 'i2' }),
        end('a2', { id: 'work' }),
        end('i2', { id: 'inner' }),
        end('o1', { id: 'outer' }),
      ]),
    )
    expect(state.retries_absorbed).toBe(1)
    expect(state.scars).toBe(0)
    expect(node_of(state, 'work').status).toBe('done')
  })

  it('classifies the absorbing parent by structure kind, not its display name', () => {
    const state = reduce(
      RETRY_FLOW,
      stream([
        start('r1', 'enrich harder', { id: 'retry_x' }),
        start('a1', 'step', { id: 'unlucky', parent_span_id: 'r1' }),
        end('a1', { id: 'unlucky', error: 'boom' }),
        start('a2', 'step', { id: 'unlucky', parent_span_id: 'r1' }),
        end('a2', { id: 'unlucky' }),
        end('r1', { id: 'retry_x' }),
      ]),
    )
    expect(state.retries_absorbed).toBe(1)
    expect(state.scars).toBe(0)
  })

  it('counts engine turn_retry into the header and marks the exact node', () => {
    const SEQ: FlowNode = {
      kind: 'sequence',
      id: 'seq',
      children: [{ kind: 'step', id: 'work' }],
    }
    const state = reduce(
      SEQ,
      stream([
        start('s0', 'sequence', { id: 'seq' }),
        start('s1', 'step', { id: 'work', parent_span_id: 's0' }),
        start('e1', 'engine.generate', { parent_span_id: 's1' }),
        start('e2', 'engine.generate.step', { parent_span_id: 'e1' }),
        { kind: 'turn_retry', span_id: 'e2', attempt: 1, failure_kind: 'rate_limit' },
      ]),
    )
    expect(state.retries_absorbed).toBe(1)
    expect(node_of(state, 'work').turn_retries).toBe(1)
    expect(node_of(state, 'seq').turn_retries).toBe(0)
  })

  it('attributes a span-less turn_retry to the deepest open span', () => {
    const SEQ: FlowNode = {
      kind: 'sequence',
      id: 'seq',
      children: [{ kind: 'step', id: 'work' }],
    }
    const state = reduce(
      SEQ,
      stream([
        start('s0', 'sequence', { id: 'seq' }),
        start('s1', 'step', { id: 'work', parent_span_id: 's0' }),
        { kind: 'turn_retry', attempt: 1, failure_kind: 'server_error' },
        { kind: 'turn_retry', attempt: 2, failure_kind: 'server_error' },
      ]),
    )
    expect(state.retries_absorbed).toBe(2)
    expect(node_of(state, 'work').turn_retries).toBe(2)
  })

  it('prefers the event span over the open stack when both could answer', () => {
    const PAR: FlowNode = {
      kind: 'parallel',
      id: 'par',
      children: [
        { kind: 'step', id: 'left' },
        { kind: 'step', id: 'right' },
      ],
    }
    const state = reduce(
      PAR,
      stream([
        start('p0', 'parallel', { id: 'par' }),
        start('l1', 'step', { id: 'left', parent_span_id: 'p0' }),
        start('r1', 'step', { id: 'right', parent_span_id: 'p0' }),
        { kind: 'turn_retry', span_id: 'l1', attempt: 1, failure_kind: 'timeout' },
      ]),
    )
    expect(node_of(state, 'left').turn_retries).toBe(1)
    expect(node_of(state, 'right').turn_retries).toBe(0)
  })

  it('still counts a turn_retry it cannot place on any node', () => {
    const state = reduce(null, stream([{ kind: 'turn_retry', attempt: 1 }]))
    expect(state.retries_absorbed).toBe(1)
    expect(state.nodes.size).toBe(0)
  })
})

describe('scar placement', () => {
  const SEQ: FlowNode = {
    kind: 'sequence',
    id: 'seq',
    children: [{ kind: 'step', id: 'work' }],
  }

  it('scars the origin and leaves the relaying ancestors unscarred', () => {
    const state = reduce(
      SEQ,
      stream([
        start('s0', 'sequence', { id: 'seq' }),
        start('s1', 'step', { id: 'work', parent_span_id: 's0' }),
        end('s1', { id: 'work', error: 'boom' }),
        end('s0', { id: 'seq', error: 'boom' }),
        { kind: 'run_end', status: 'failed' },
      ]),
    )
    expect(scarred_ids(state)).toEqual(['work'])
    expect(state.scars).toBe(1)
    expect(node_of(state, 'seq').status).toBe('failed')
  })

  it('scars a parent that fails on its own after its child succeeded', () => {
    const state = reduce(
      SEQ,
      stream([
        start('s0', 'sequence', { id: 'seq' }),
        start('s1', 'step', { id: 'work', parent_span_id: 's0' }),
        end('s1', { id: 'work' }),
        end('s0', { id: 'seq', error: 'combine step blew up' }),
      ]),
    )
    expect(scarred_ids(state)).toEqual(['seq'])
    expect(node_of(state, 'work').scarred).toBe(false)
  })

  it('lands an engine-origin failure on the deepest structure-joined span', () => {
    const state = reduce(
      SEQ,
      stream([
        start('s0', 'sequence', { id: 'seq' }),
        start('s1', 'step', { id: 'work', parent_span_id: 's0' }),
        start('e1', 'engine.generate', { parent_span_id: 's1' }),
        start('e2', 'engine.generate.step', { parent_span_id: 'e1' }),
        end('e2', { error: 'provider terminal' }),
        end('e1', { error: 'provider terminal' }),
        end('s1', { id: 'work', error: 'provider terminal' }),
        end('s0', { id: 'seq', error: 'provider terminal' }),
      ]),
    )
    expect(scarred_ids(state)).toEqual(['work'])
    expect(state.scars).toBe(1)
  })

  it('scars both fallback children when the backup dies too', () => {
    const FALLBACK: FlowNode = {
      kind: 'fallback',
      id: 'fb',
      children: [
        { kind: 'step', id: 'primary' },
        { kind: 'step', id: 'backup' },
      ],
    }
    const state = reduce(
      FALLBACK,
      stream([
        start('f0', 'fallback', { id: 'fb' }),
        start('p1', 'step', { id: 'primary', parent_span_id: 'f0' }),
        end('p1', { id: 'primary', error: 'down' }),
        start('b1', 'step', { id: 'backup', parent_span_id: 'f0' }),
        end('b1', { id: 'backup', error: 'also down' }),
        end('f0', { id: 'fb', error: 'also down' }),
        { kind: 'run_end', status: 'failed' },
      ]),
    )
    expect(scarred_ids(state).toSorted()).toEqual(['backup', 'primary'])
    expect(state.scars).toBe(2)
    expect(node_of(state, 'fb').scarred).toBe(false)
  })

  it('terminates on a malformed span parent cycle instead of hanging (C7)', () => {
    const state = reduce(
      null,
      stream([
        start('a', 'step', { id: 'alpha', parent_span_id: 'b' }),
        start('b', 'step', { id: 'beta', parent_span_id: 'a' }),
        end('a', { id: 'alpha', error: 'boom' }),
      ]),
    )
    expect(scarred_ids(state)).toEqual(['alpha'])
    expect(state.retries_absorbed).toBe(0)
  })

  it('scars a map child once however many instances die', () => {
    const MAP: FlowNode = {
      kind: 'map',
      id: 'fan',
      children: [{ kind: 'step', id: 'item' }],
    }
    const state = reduce(
      MAP,
      stream([
        start('m0', 'map', { id: 'fan' }),
        start('i1', 'step', { id: 'item', parent_span_id: 'm0' }),
        start('i2', 'step', { id: 'item', parent_span_id: 'm0' }),
        start('i3', 'step', { id: 'item', parent_span_id: 'm0' }),
        end('i1', { id: 'item', error: 'bad row' }),
        end('i2', { id: 'item' }),
        end('i3', { id: 'item', error: 'bad row' }),
      ]),
    )
    expect(state.scars).toBe(1)
    expect(node_of(state, 'item').scarred).toBe(true)
    expect(
      node_of(state, 'item').occurrences.map((occurrence) => occurrence.status),
    ).toEqual(['failed', 'done', 'failed'])
  })
})

describe('suspension', () => {
  const SEQ: FlowNode = {
    kind: 'sequence',
    id: 'seq',
    children: [{ kind: 'suspend', id: 'gate' }],
  }
  const suspend_events = stream([
    start('s0', 'sequence', { id: 'seq' }),
    start('g1', 'suspend', { id: 'gate', parent_span_id: 's0' }),
    { kind: 'suspended', suspend_id: 'gate', step_id: 'gate' },
    end('g1', { id: 'gate', error: 'suspended: gate' }),
    end('s0', { id: 'seq', error: 'suspended: gate' }),
    { kind: 'run_end', status: 'suspended' },
  ])

  it('parks the node as suspended instead of failed, with no scar', () => {
    const state = reduce(SEQ, suspend_events)
    expect(node_of(state, 'gate').status).toBe('suspended')
    expect(node_of(state, 'gate').suspended).toBe(true)
    expect(node_of(state, 'gate').occurrences).toHaveLength(1)
    expect(state.scars).toBe(0)
    expect(state.retries_absorbed).toBe(0)
    expect(state.run_status).toBe('suspended')
  })

  it('ignores a suspended event that names no step', () => {
    const state = reduce(null, [{ kind: 'suspended', suspend_id: 'gate' }])
    expect(state.nodes.size).toBe(0)
  })

  it('lifts the suspension when the node runs again', () => {
    const resumed = [
      ...suspend_events,
      { kind: 'span_start', span_id: 'g2', name: 'suspend', id: 'gate', ts: 2000 },
    ]
    const state = reduce(SEQ, resumed)
    expect(node_of(state, 'gate').suspended).toBe(false)
    expect(node_of(state, 'gate').status).toBe('active')
  })
})

describe('emit marks', () => {
  const SEQ: FlowNode = {
    kind: 'sequence',
    id: 'seq',
    children: [{ kind: 'step', id: 'work' }],
  }
  const open_work = [
    start('s0', 'sequence', { id: 'seq' }),
    start('s1', 'step', { id: 'work', parent_span_id: 's0' }),
  ]

  it('lands a bare emit on the deepest open span, like a pre-E cost', () => {
    const state = reduce(SEQ, stream([...open_work, { kind: 'emit', label: 'tick' }]))
    expect(node_of(state, 'work').emits).toBe(1)
    expect(node_of(state, 'seq').emits).toBe(0)
  })

  it('prefers a stamped span_id over the open stack', () => {
    const state = reduce(
      SEQ,
      stream([
        ...open_work,
        start('e1', 'engine.generate', { parent_span_id: 's0' }),
        { kind: 'emit', span_id: 's1' },
      ]),
    )
    expect(node_of(state, 'work').emits).toBe(1)
  })

  it('accumulates one count per event', () => {
    const state = reduce(
      SEQ,
      stream([...open_work, { kind: 'emit' }, { kind: 'emit' }, { kind: 'emit' }]),
    )
    expect(node_of(state, 'work').emits).toBe(3)
  })

  it('drops an emit it cannot place, without inventing a node', () => {
    const nowhere = reduce(SEQ, stream([{ kind: 'emit', label: 'lost' }]))
    expect(node_of(nowhere, 'work').emits).toBe(0)
    expect(node_of(nowhere, 'seq').emits).toBe(0)
    const ghost = reduce(SEQ, stream([...open_work, { kind: 'emit', span_id: 'ghost' }]))
    expect(node_of(ghost, 'work').emits).toBe(0)
    expect(ghost.nodes.size).toBe(2)
  })
})

describe('checkpoint lookups', () => {
  const SEQ: FlowNode = {
    kind: 'sequence',
    id: 'seq',
    children: [{ kind: 'checkpoint', id: 'cp', children: [{ kind: 'step', id: 'work' }] }],
  }

  it('records each known outcome on the node the event names', () => {
    for (const status of ['hit', 'miss', 'read_error'] as const) {
      const state = reduce(SEQ, stream([{ kind: 'checkpoint', status, id: 'cp' }]))
      expect(node_of(state, 'cp').checkpoint).toBe(status)
      expect(node_of(state, 'work').checkpoint).toBeNull()
    }
  })

  it('keeps the newest outcome when a resumed run looks the key up again', () => {
    const state = reduce(
      SEQ,
      stream([
        { kind: 'checkpoint', status: 'read_error', id: 'cp' },
        { kind: 'checkpoint', status: 'hit', id: 'cp' },
      ]),
    )
    expect(node_of(state, 'cp').checkpoint).toBe('hit')
  })

  it('stays inert on an unknown status or a missing id (C7)', () => {
    const unknown = reduce(SEQ, stream([{ kind: 'checkpoint', status: 'warm', id: 'cp' }]))
    expect(node_of(unknown, 'cp').checkpoint).toBeNull()
    const nameless = reduce(SEQ, stream([{ kind: 'checkpoint', status: 'hit' }]))
    expect(node_of(nameless, 'cp').checkpoint).toBeNull()
    expect(nameless.nodes.size).toBe(3)
  })

  it('accretes a node for a checkpoint the structure does not know (C7)', () => {
    const state = reduce(null, stream([{ kind: 'checkpoint', status: 'hit', id: 'lone' }]))
    expect(node_of(state, 'lone').checkpoint).toBe('hit')
    expect(node_of(state, 'lone').status).toBe('pending')
  })
})

describe('cost rollup', () => {
  const SEQ: FlowNode = {
    kind: 'sequence',
    id: 'seq',
    children: [{ kind: 'step', id: 'work' }],
  }
  const engine_spans = [
    start('s0', 'sequence', { id: 'seq' }),
    start('s1', 'step', { id: 'work', parent_span_id: 's0' }),
    start('e1', 'engine.generate', { parent_span_id: 's1' }),
    start('e2', 'engine.generate.step', { parent_span_id: 'e1' }),
  ]

  it('attributes exactly through the engine span chain (E)', () => {
    const state = reduce(
      SEQ,
      stream([...engine_spans, { kind: 'cost', span_id: 'e2', total_usd: 0.004 }]),
    )
    expect(node_of(state, 'work').cost_usd).toBe(0.004)
    expect(node_of(state, 'seq').cost_usd).toBe(0)
    expect(state.cost_usd).toBe(0.004)
    expect(state.unattributed_usd).toBe(0)
  })

  it('accumulates repeated costs onto the same node', () => {
    const state = reduce(
      SEQ,
      stream([
        ...engine_spans,
        { kind: 'cost', span_id: 'e2', total_usd: 0.004 },
        { kind: 'cost', span_id: 'e2', total_usd: 0.006 },
      ]),
    )
    expect(node_of(state, 'work').cost_usd).toBeCloseTo(0.01, 10)
    expect(state.cost_usd).toBeCloseTo(0.01, 10)
  })

  it('prefers the event span over the open stack when both could answer', () => {
    const PAR: FlowNode = {
      kind: 'parallel',
      id: 'par',
      children: [
        { kind: 'step', id: 'left' },
        { kind: 'step', id: 'right' },
      ],
    }
    const state = reduce(
      PAR,
      stream([
        start('p0', 'parallel', { id: 'par' }),
        start('l1', 'step', { id: 'left', parent_span_id: 'p0' }),
        start('r1', 'step', { id: 'right', parent_span_id: 'p0' }),
        { kind: 'cost', span_id: 'l1', total_usd: 0.25 },
      ]),
    )
    expect(node_of(state, 'left').cost_usd).toBe(0.25)
    expect(node_of(state, 'right').cost_usd).toBe(0)
  })

  it('drops a cost whose span chain cycles without reaching a node (C7)', () => {
    const state = reduce(
      null,
      stream([
        { kind: 'span_start', span_id: 'a', name: 'engine.a', parent_span_id: 'b' },
        { kind: 'span_start', span_id: 'b', name: 'engine.b', parent_span_id: 'a' },
        { kind: 'cost', span_id: 'a', total_usd: 0.5 },
      ]),
    )
    expect(state.unattributed_usd).toBe(0.5)
    expect(state.cost_usd).toBe(0.5)
  })

  it('attributes exactly even after the named span has closed', () => {
    const state = reduce(
      SEQ,
      stream([
        ...engine_spans,
        end('e2'),
        end('e1'),
        end('s1', { id: 'work' }),
        { kind: 'cost', span_id: 'e2', total_usd: 0.004 },
      ]),
    )
    expect(node_of(state, 'work').cost_usd).toBe(0.004)
  })

  it('falls back to the deepest open span for a span-less cost event', () => {
    const state = reduce(
      SEQ,
      stream([...engine_spans, { kind: 'cost', total_usd: 0.01 }]),
    )
    expect(node_of(state, 'work').cost_usd).toBe(0.01)
    expect(node_of(state, 'seq').cost_usd).toBe(0)
  })

  it('re-aims the open-stack heuristic when the deepest span closes', () => {
    const state = reduce(
      SEQ,
      stream([
        start('s0', 'sequence', { id: 'seq' }),
        start('s1', 'step', { id: 'work', parent_span_id: 's0' }),
        end('s1', { id: 'work' }),
        { kind: 'cost', total_usd: 0.02 },
      ]),
    )
    expect(node_of(state, 'seq').cost_usd).toBe(0.02)
    expect(node_of(state, 'work').cost_usd).toBe(0)
  })

  it('keeps a cost it cannot place in the legible unattributed bucket', () => {
    const state = reduce(SEQ, stream([{ kind: 'cost', total_usd: 0.02 }]))
    expect(state.unattributed_usd).toBe(0.02)
    expect(state.cost_usd).toBe(0.02)
    expect(node_of(state, 'work').cost_usd).toBe(0)
  })

  it('treats an unknown span_id as unattributable, not an error', () => {
    const state = reduce(
      SEQ,
      stream([{ kind: 'cost', span_id: 'ghost', total_usd: 0.5 }]),
    )
    expect(state.unattributed_usd).toBe(0.5)
    expect(state.cost_usd).toBe(0.5)
  })

  it('ignores a cost event without a numeric total', () => {
    const state = reduce(SEQ, stream([{ kind: 'cost', total_usd: 'lots' }]))
    expect(state.cost_usd).toBe(0)
    expect(state.unattributed_usd).toBe(0)
  })
})

describe('wire permissiveness (C7)', () => {
  it('advances only the clock on an unknown kind', () => {
    const before = reduce(structure, fixture)
    const after = apply_event(before, { kind: 'hologram', ts: 9_999_999_999_999 })
    expect(after.last_ts).toBe(9_999_999_999_999)
    expect(after.nodes).toEqual(before.nodes)
    expect(after.scars).toBe(before.scars)
    expect(after.cost_usd).toBe(before.cost_usd)
  })

  it('returns the same state reference for values that are not events', () => {
    const state = initial_state(structure)
    expect(apply_event(state, null)).toBe(state)
    expect(apply_event(state, undefined)).toBe(state)
    expect(apply_event(state, 'span_start')).toBe(state)
    expect(apply_event(state, 42)).toBe(state)
    expect(apply_event(state, ['span_start'])).toBe(state)
    expect(apply_event(state, { span_id: 'x' })).toBe(state)
    expect(apply_event(state, { kind: 42 })).toBe(state)
  })

  it('rejects a NaN ts instead of poisoning the clock', () => {
    const state = reduce(null, [{ kind: 'a', ts: Number.NaN }])
    expect(state.t0_ts).toBeNull()
    expect(state.last_ts).toBeNull()
    expect(t_plus_ms(state)).toBe(0)
  })

  it('drops a span_start missing its span id', () => {
    const state = reduce(null, [{ kind: 'span_start', name: 'step', id: 'work' }])
    expect(state.spans.size).toBe(0)
    expect(state.nodes.size).toBe(0)
  })

  it('registers an engine span without creating a node for it', () => {
    const state = reduce(null, stream([start('e1', 'engine.generate')]))
    expect(state.spans.size).toBe(1)
    expect(state.nodes.size).toBe(0)
  })

  it('drops a span_end for a span it never saw open', () => {
    const state = reduce(structure, [
      ...fixture.slice(0, 1),
      { kind: 'span_end', span_id: 'ghost', error: 'boom', ts: 1787368870100 },
    ])
    expect(state.scars).toBe(0)
    expect(statuses(state)['sequence_1']).toBe('pending')
  })

  it('ignores a second close of the same span', () => {
    const SEQ: FlowNode = { kind: 'step', id: 'work' }
    const state = reduce(
      SEQ,
      stream([
        start('s1', 'step', { id: 'work' }),
        end('s1', { id: 'work' }),
        end('s1', { id: 'work', error: 'late boom' }),
      ]),
    )
    expect(node_of(state, 'work').status).toBe('done')
    expect(state.scars).toBe(0)
  })

  it('drops a span_start missing its name from the registry and the stack', () => {
    const state = reduce(
      null,
      stream([
        { kind: 'span_start', span_id: 's1' },
        { kind: 'cost', total_usd: 0.01 },
      ]),
    )
    expect(state.spans.size).toBe(0)
    expect(state.unattributed_usd).toBe(0.01)
  })

  it('leaves the clock alone when an event carries no usable ts', () => {
    const state = reduce(null, [
      { kind: 'a', ts: 500 },
      { kind: 'b', ts: 'later' },
      { kind: 'c' },
    ])
    expect(state.t0_ts).toBe(500)
    expect(state.last_ts).toBe(500)
  })

  it('clamps a clock that runs backwards to zero elapsed', () => {
    const state = reduce(null, [
      { kind: 'a', ts: 500 },
      { kind: 'b', ts: 90 },
    ])
    expect(t_plus_ms(state)).toBe(0)
  })

  it('keeps the first run id it saw', () => {
    const state = reduce(null, [
      { kind: 'a', run_id: 'first-run' },
      { kind: 'b', run_id: 'second-run' },
    ])
    expect(state.run_id).toBe('first-run')
  })

  it('ignores a run_end carrying an unknown status', () => {
    const state = reduce(null, [{ kind: 'run_end', status: 'transcended' }])
    expect(state.run_status).toBeNull()
  })

  it('resolves each known terminal status', () => {
    expect(reduce(null, [{ kind: 'run_end', status: 'aborted' }]).run_status).toBe('aborted')
    expect(reduce(null, [{ kind: 'run_end', status: 'failed' }]).run_status).toBe('failed')
    expect(reduce(null, [{ kind: 'run_end', status: 'suspended' }]).run_status).toBe(
      'suspended',
    )
  })
})
