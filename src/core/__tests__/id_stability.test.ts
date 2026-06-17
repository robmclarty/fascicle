/**
 * Contract: step ids reported by describe.json are stable per Step instance,
 * and every trajectory event referencing a step id uses an id that exists in
 * that flow's describe.json output.
 *
 * Studio depends on this to correlate live events with graph nodes. If a
 * future refactor breaks either property, this test fails before any UI does.
 */

import { describe as vdescribe, expect, it } from 'vitest'
import { branch } from '../branch.js'
import { describe } from '../describe.js'
import { parallel } from '../parallel.js'
import { retry } from '../retry.js'
import { run } from '../runner.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'
import type { FlowNode } from '../describe.js'
import type { TrajectoryEvent, TrajectoryLogger } from '../types.js'

function collect_ids(node: FlowNode, into: Set<string> = new Set()): Set<string> {
  into.add(node.id)
  if (node.children) {
    for (const child of node.children) collect_ids(child, into)
  }
  return into
}

function recording_logger(): {
  readonly logger: TrajectoryLogger
  readonly events: TrajectoryEvent[]
} {
  const events: TrajectoryEvent[] = []
  let counter = 0
  const logger: TrajectoryLogger = {
    record: (event) => {
      events.push(event)
    },
    start_span: (name, meta) => {
      counter += 1
      const span_id = `${name}:${counter}`
      events.push({ kind: 'span_start', span_id, name, ...meta })
      return span_id
    },
    end_span: (id, meta) => {
      events.push({ kind: 'span_end', span_id: id, ...meta })
    },
  }
  return { logger, events }
}

vdescribe('id stability contract', () => {
  it('describe.json returns deeply-equal output across calls on the same Step', () => {
    const flow = sequence([
      step('parse', (raw: string) => raw.trim()),
      branch({
        when: (s: string) => s.length > 0,
        then: step('upper', (s: string) => s.toUpperCase()),
        otherwise: step('empty', () => ''),
      }),
    ])
  
    const a = describe.json(flow)
    const b = describe.json(flow)
    expect(b).toEqual(a)
  })

  it('every trajectory event id references a step id present in describe.json', async () => {
    const flow = retry(
      sequence([
        step('add', (n: number) => n + 1),
        parallel({
          double: step('double', (n: number) => n * 2),
          square: step('square', (n: number) => n * n),
        }),
      ]),
      { max_attempts: 1 },
    )
  
    const tree = describe.json(flow)
    const known_ids = collect_ids(tree)
  
    const { logger, events } = recording_logger()
    await run(flow, 3, { trajectory: logger, install_signal_handlers: false })
  
    const referenced_ids = new Set<string>()
    for (const event of events) {
      const id = event['id']
      if (typeof id === 'string') referenced_ids.add(id)
    }
  
    expect(referenced_ids.size).toBeGreaterThan(0)
    for (const id of referenced_ids) {
      expect(known_ids).toContain(id)
    }
  })

  it('every trajectory event automatically carries run_id', async () => {
    const flow = sequence([
      step('a', (n: number) => n + 1),
      step('b', (n: number, ctx) => {
        ctx.emit({ label: 'progress', value: n })
        return n
      }),
    ])
  
    const { logger, events } = recording_logger()
    await run(flow, 0, { trajectory: logger, install_signal_handlers: false })
  
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event['run_id']).toBeDefined()
      expect(typeof event['run_id']).toBe('string')
    }
  
    const run_ids = new Set(events.map((e) => e['run_id']))
    expect(run_ids.size).toBe(1)
  })

  it('does not overwrite a caller-supplied run_id on a record event', async () => {
    const flow = step('emit_with_id', (_input: unknown, ctx) => {
      ctx.trajectory.record({ kind: 'custom', run_id: 'caller-supplied' })
      return null
    })
  
    const { logger, events } = recording_logger()
    await run(flow, undefined, { trajectory: logger, install_signal_handlers: false })
  
    const custom = events.find((e) => e['kind'] === 'custom')
    expect(custom?.['run_id']).toBe('caller-supplied')
  })

  it('the same Step instance keeps the same id across describe and run', async () => {
    const leaf = step('leaf', (n: number) => n + 1)
    const flow = sequence([leaf])
  
    const tree = describe.json(flow)
    const tree_leaf = tree.children?.[0]
    expect(tree_leaf?.id).toBe(leaf.id)
  
    const { logger, events } = recording_logger()
    await run(flow, 0, { trajectory: logger, install_signal_handlers: false })
  
    const observed_leaf_event = events.find(
      (e) => e['kind'] === 'span_start' && e['name'] === 'step' && e['id'] === leaf.id,
    )
    expect(observed_leaf_event).toBeDefined()
  })
})
