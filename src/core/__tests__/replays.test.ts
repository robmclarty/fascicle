import { describe as vdescribe, expect, it } from 'vitest'
import { z } from 'zod'
import { branch } from '../branch.js'
import { checkpoint } from '../checkpoint.js'
import { compose } from '../compose.js'
import { describe } from '../describe.js'
import { fallback } from '../fallback.js'
import { loop } from '../loop.js'
import { map } from '../map.js'
import { parallel } from '../parallel.js'
import { find_replays } from '../replays.js'
import { scope, stash } from '../scope.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'
import { suspend } from '../suspend.js'
import type { FlowNode, Step } from '../types.js'

// A step that bills for every run, the kind a replay pays for twice.
function paid(id: string, name?: string): Step<number, number> {
  return step(id, (x: number) => x, name === undefined ? { side_effect: true } : { side_effect: true, name })
}

function free(id: string): Step<number, number> {
  return step(id, (x: number) => x)
}

function gate_at(id: string): Step<number, number> {
  return suspend({ id, on: () => {}, resume_schema: z.object({}), combine: (x: number) => x })
}

vdescribe('describe.replays', () => {
  it('names a paid step that runs before a gate, and not one that runs after', () => {
    const flow = sequence([paid('fetch'), gate_at('approve'), paid('post')])
    expect(describe.replays(flow)).toStrictEqual([{ id: 'fetch', label: 'fetch', gates: ['approve'] }])
  })

  it('finds nothing in a flow without gates, or without paid steps', () => {
    expect(describe.replays(sequence([paid('fetch'), paid('post')]))).toStrictEqual([])
    expect(describe.replays(sequence([free('fetch'), gate_at('approve')]))).toStrictEqual([])
  })

  it('lists every gate a step runs before, in flow order', () => {
    const flow = sequence([paid('fetch'), gate_at('first'), gate_at('second')])
    expect(describe.replays(flow)).toStrictEqual([{ id: 'fetch', label: 'fetch', gates: ['first', 'second'] }])
  })

  it('lets a checkpoint that holds the step protect it from the gate', () => {
    const flow = sequence([checkpoint(paid('fetch'), { key: 'fetch' }), gate_at('approve')])
    expect(describe.replays(flow)).toStrictEqual([])
  })

  it('gives no protection to a checkpoint that holds the gate as well', () => {
    const flow = checkpoint(sequence([paid('fetch'), gate_at('approve')]), { key: 'both' })
    expect(describe.replays(flow)).toStrictEqual([{ id: 'fetch', label: 'fetch', gates: ['approve'] }])
  })

  it('protects a step from one gate and not from a gate inside the same checkpoint', () => {
    const flow = sequence([checkpoint(sequence([paid('fetch'), gate_at('inner')]), { key: 'k' }), gate_at('outer')])
    expect(describe.replays(flow)).toStrictEqual([{ id: 'fetch', label: 'fetch', gates: ['inner'] }])
  })

  it('reads parallel members as starting together, whichever is declared first', () => {
    expect(describe.replays(parallel({ work: paid('fetch'), wait: gate_at('approve') }))).toStrictEqual([
      { id: 'fetch', label: 'fetch', gates: ['approve'] },
    ])
    expect(describe.replays(parallel({ wait: gate_at('approve'), work: paid('fetch') }))).toStrictEqual([
      { id: 'fetch', label: 'fetch', gates: ['approve'] },
    ])
  })

  it('never orders the arms of a branch against each other', () => {
    const flow = branch({ when: () => true, then: paid('fetch'), otherwise: gate_at('approve') })
    expect(describe.replays(flow)).toStrictEqual([])
  })

  it('orders a step before a branch ahead of a gate in either arm', () => {
    const flow = sequence([
      paid('fetch'),
      branch({ when: () => true, then: gate_at('approve'), otherwise: free('skip') }),
    ])
    expect(describe.replays(flow)).toStrictEqual([{ id: 'fetch', label: 'fetch', gates: ['approve'] }])
  })

  it("orders a loop's body before its guard within a round, and not the other way", () => {
    const guarded = (body: Step<number, number>, guard: Step<number, { stop: boolean; state: number }>) =>
      loop({ init: (x: number) => x, body, guard, finish: (x) => x, max_rounds: 3 })
    const stop_gate = suspend({
      id: 'enough',
      on: () => {},
      resume_schema: z.object({}),
      combine: (state: number) => ({ stop: true, state }),
    })
    const paid_guard = step('judge', (state: number) => ({ stop: true, state }), { side_effect: true })
    expect(describe.replays(guarded(paid('work'), stop_gate))).toStrictEqual([
      { id: 'work', label: 'work', gates: ['enough'] },
    ])
    expect(describe.replays(guarded(gate_at('approve'), paid_guard))).toStrictEqual([])
  })

  it("orders a fallback's primary before its backup", () => {
    expect(describe.replays(fallback(paid('primary'), gate_at('approve')))).toStrictEqual([
      { id: 'primary', label: 'primary', gates: ['approve'] },
    ])
    expect(describe.replays(fallback(gate_at('approve'), paid('backup')))).toStrictEqual([])
  })

  it('orders the steps inside one map item', () => {
    const items = (xs: number[]) => xs
    expect(describe.replays(map({ items, do: sequence([paid('work'), gate_at('approve')]) }))).toStrictEqual([
      { id: 'work', label: 'work', gates: ['approve'] },
    ])
    expect(describe.replays(map({ items, do: sequence([gate_at('approve'), paid('work')]) }))).toStrictEqual([])
  })

  it("reads a step's arms as running in whatever order its body calls them", () => {
    const flow = step('review', (x: number) => x, { arm: [gate_at('approve'), paid('draft')] })
    expect(describe.replays(flow)).toStrictEqual([{ id: 'draft', label: 'draft', gates: ['approve'] }])
  })

  it('sees a paid call that a direct-style step declares as its arm', () => {
    const drafting = step('drafting', (x: number) => x, { arm: paid('model') })
    expect(describe.replays(sequence([drafting, gate_at('approve')]))).toStrictEqual([
      { id: 'model', label: 'model', gates: ['approve'] },
    ])
  })

  it('names a paid step that holds the gate, since it starts first', () => {
    const wrapper = step('wrapper', (x: number) => x, { arm: gate_at('approve'), side_effect: true })
    expect(describe.replays(wrapper)).toStrictEqual([{ id: 'wrapper', label: 'wrapper', gates: ['approve'] }])
  })

  it('protects the work a gate composite checkpoints ahead of its approval', () => {
    // The shape `gate` builds: the checkpointed work is stashed, projected,
    // and handed to the suspend.
    const flow = compose(
      scope([stash('result', checkpoint(paid('draft'), { key: 'gate:approve' })), free('project_payload'), gate_at('approve')]),
      { name: 'gate' },
    )
    expect(describe.replays(flow)).toStrictEqual([])
  })

  it('labels a step the way the diagram does', () => {
    const anonymous = step((x: number) => x)
    const marked: Step<number, number> = { ...anonymous, meta: { side_effect: true } }
    const flow = sequence([paid('fetch', 'fetch the diff'), marked, gate_at('approve')])
    expect(describe.replays(flow)).toStrictEqual([
      { id: 'fetch', label: 'fetch the diff', gates: ['approve'] },
      { id: anonymous.id, label: 'step', gates: ['approve'] },
    ])
  })

  it('gives a step that appears twice one hint, with the gates of both places', () => {
    const shared = paid('shared')
    const flow = sequence([shared, gate_at('first'), shared, gate_at('second')])
    expect(describe.replays(flow)).toStrictEqual([{ id: 'shared', label: 'shared', gates: ['first', 'second'] }])
  })

  it('lists a gate that appears twice once', () => {
    const approve = gate_at('approve')
    expect(describe.replays(sequence([paid('fetch'), approve, approve]))).toStrictEqual([
      { id: 'fetch', label: 'fetch', gates: ['approve'] },
    ])
  })
})

vdescribe('find_replays', () => {
  const paid_node: FlowNode = { kind: 'step', id: 'fetch', meta: { side_effect: true } }
  const gate_node: FlowNode = { kind: 'suspend', id: 'approve', config: { id: 'approve' } }

  it("runs an unknown kind's children in order", () => {
    expect(find_replays({ kind: 'custom', id: 'c', children: [paid_node, gate_node] })).toStrictEqual([
      { id: 'fetch', label: 'fetch', gates: ['approve'] },
    ])
    expect(find_replays({ kind: 'custom', id: 'c', children: [gate_node, paid_node] })).toStrictEqual([])
  })

  it('never has a gate run before itself', () => {
    const marked_gate: FlowNode = { ...gate_node, meta: { side_effect: true } }
    expect(find_replays({ kind: 'sequence', id: 'sequence_1', children: [marked_gate] })).toStrictEqual([])
  })

  it('never has a step run before a gate that a hand-built tree puts above it', () => {
    expect(find_replays({ ...gate_node, children: [paid_node] })).toStrictEqual([])
  })

  it('reads a cycle marker as a leaf', () => {
    const cycle: FlowNode = { kind: '<cycle>', id: 'sequence_1' }
    expect(find_replays({ kind: 'sequence', id: 'sequence_1', children: [paid_node, cycle, gate_node] })).toStrictEqual([
      { id: 'fetch', label: 'fetch', gates: ['approve'] },
    ])
  })
})
