import { describe as describe_flow, run, step } from '#core'
import type { CheckpointStore, FlowNode, RunOutcome } from '#core'
import { describe, expect, it, vi } from 'vitest'
import { gate } from '../gate.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'

function memory_store(): CheckpointStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get(key) {
      return data.has(key) ? data.get(key) : null
    },
    async set(key, value) {
      data.set(key, value)
    },
    async delete(key) {
      data.delete(key)
    },
  }
}

function expect_suspended<o>(
  outcome: RunOutcome<o>,
): Extract<RunOutcome<o>, { kind: 'suspended' }> {
  if (outcome.kind !== 'suspended') {
    throw new Error(`expected a suspended outcome; got ${outcome.kind}`)
  }
  return outcome
}

function find_node(
  node: FlowNode,
  matches: (n: FlowNode) => boolean,
): FlowNode | undefined {
  if (matches(node)) return node
  for (const child of node.children ?? []) {
    const found = find_node(child, matches)
    if (found) return found
  }
  return undefined
}

describe('gate (composite)', () => {
  it('runs inner once, suspends with the result as payload, and passes the inner result through on resume', async () => {
    const spy = vi.fn((brief: string) => `draft of ${brief}`)
    const store = memory_store()
    const flow = gate(step('draft', spy), { id: 'approve', store })

    const outcome = await run.until_suspended(flow, 'launch', {
      install_signal_handlers: false,
    })
    const suspended = expect_suspended(outcome)
    expect(suspended.id).toBe('approve')
    expect(suspended.payload).toEqual({ input: 'draft of launch' })
    // The paid work is durable before anyone approves anything.
    expect(store.data.get('gate:approve')).toBe('draft of launch')

    const resumed = await suspended.resume({ approved: true })
    expect(resumed.kind).toBe('done')
    if (resumed.kind === 'done') {
      // The decision is signal-only: the output is the inner result, not the
      // resume data.
      expect(resumed.output).toBe('draft of launch')
    }
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('replays from the store on a fresh run after a restart: inner does not re-execute', async () => {
    const store = memory_store()
    const calls: string[] = []
    const build_flow = () =>
      gate(
        step('draft', (brief: string) => {
          calls.push(brief)
          return `draft of ${brief}`
        }),
        { id: 'approve', store },
      )

    const first = expect_suspended(
      await run.until_suspended(build_flow(), 'launch', {
        install_signal_handlers: false,
      }),
    )
    expect(first.id).toBe('approve')
    expect(calls).toHaveLength(1)

    // Simulate a process restart: a rebuilt flow, the same durable store, no
    // in-memory resume closure surviving. The rebuilt gate must land on the
    // same key, so the key can carry no construction-time counter.
    const { logger, events } = recording_logger()
    const second = expect_suspended(
      await run.until_suspended(build_flow(), 'launch', {
        trajectory: logger,
        install_signal_handlers: false,
      }),
    )
    expect(calls).toHaveLength(1)
    expect(second.payload).toEqual({ input: 'draft of launch' })

    const lookups = events.filter((e) => e.kind === 'checkpoint')
    expect(lookups).toHaveLength(1)
    expect(lookups[0]?.['status']).toBe('hit')
    expect(lookups[0]?.['key']).toBe('gate:approve')

    const resumed = await second.resume('yes')
    expect(resumed.kind).toBe('done')
    if (resumed.kind === 'done') {
      expect(resumed.output).toBe('draft of launch')
    }
    expect(calls).toHaveLength(1)
  })

  it('still suspends and resumes in-process without a store, re-executing inner on the resume replay', async () => {
    const spy = vi.fn((n: number) => n * 2)
    const flow = gate(step('double', spy), { id: 'ok' })

    const outcome = expect_suspended(
      await run.until_suspended(flow, 21, { install_signal_handlers: false }),
    )
    expect(outcome.payload).toEqual({ input: 42 })

    const resumed = await outcome.resume(true)
    expect(resumed.kind).toBe('done')
    if (resumed.kind === 'done') {
      expect(resumed.output).toBe(42)
    }
    // Resume replays the un-checkpointed inner; that is the cost of running
    // storeless, not a gate defect.
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('prefers the gate-local store over the run-level checkpoint_store', async () => {
    const gate_store = memory_store()
    const run_store = memory_store()
    const flow = gate(step('add_one', (n: number) => n + 1), {
      id: 'bump',
      store: gate_store,
    })

    const outcome = expect_suspended(
      await run.until_suspended(flow, 1, {
        checkpoint_store: run_store,
        install_signal_handlers: false,
      }),
    )
    expect(outcome.payload).toEqual({ input: 2 })
    expect(gate_store.data.get('gate:bump')).toBe(2)
    expect(run_store.data.size).toBe(0)
  })

  it('falls back to the run-level checkpoint_store when the gate has no store of its own', async () => {
    const run_store = memory_store()
    const spy = vi.fn((n: number) => n + 1)
    const build_flow = () => gate(step('add_one', spy), { id: 'bump' })

    const first = expect_suspended(
      await run.until_suspended(build_flow(), 1, {
        checkpoint_store: run_store,
        install_signal_handlers: false,
      }),
    )
    expect(first.payload).toEqual({ input: 2 })
    expect(run_store.data.get('gate:bump')).toBe(2)

    const second = expect_suspended(
      await run.until_suspended(build_flow(), 1, {
        checkpoint_store: run_store,
        install_signal_handlers: false,
      }),
    )
    expect(second.payload).toEqual({ input: 2 })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('applies format to the suspend payload without changing the stored result or the gate output', async () => {
    const store = memory_store()
    const flow = gate(
      step('draft', (brief: string) => ({ brief, body: `full text for ${brief}` })),
      {
        id: 'approve',
        store,
        format: (r) => ({ preview: r.body.slice(0, 9) }),
      },
    )

    const outcome = expect_suspended(
      await run.until_suspended(flow, 'launch', { install_signal_handlers: false }),
    )
    expect(outcome.payload).toEqual({ input: { preview: 'full text' } })
    expect(store.data.get('gate:approve')).toEqual({
      brief: 'launch',
      body: 'full text for launch',
    })

    const resumed = await outcome.resume({ approved: true })
    expect(resumed.kind).toBe('done')
    if (resumed.kind === 'done') {
      expect(resumed.output).toEqual({ brief: 'launch', body: 'full text for launch' })
    }
  })

  it('describes as one gate composite node wrapping checkpoint, suspend, and the inner step', () => {
    const inner = step('draft', (brief: string) => `draft of ${brief}`)
    const flow = gate(inner, { id: 'approve' })

    expect(flow.kind).toBe('compose')
    expect(flow.config?.['display_name']).toBe('gate')

    const text = describe_flow(flow)
    expect(text.split('\n')[0]).toMatch(/^gate\(/)
    expect(text).toContain('checkpoint(')
    expect(text).toContain('suspend(approve)')
    expect(text).toContain('step(draft)')
    expect(text).toContain('step(project_payload)')

    const tree = describe_flow.json(flow)
    const checkpoint_node = find_node(tree, (n) => n.kind === 'checkpoint')
    expect(checkpoint_node?.config?.['key']).toBe('gate:approve')
    expect(checkpoint_node?.children?.[0]?.id).toBe('draft')
  })

  it('keeps the inner step visible in describe when a gate-local store is bound', () => {
    const flow = gate(step('draft', (b: string) => b), {
      id: 'approve',
      store: memory_store(),
    })

    const text = describe_flow(flow)
    expect(text).toContain('step(bind_store)')
    expect(text).toContain('checkpoint(')
    expect(text).toContain('step(draft)')
  })

  it('opens gate, checkpoint, and suspend spans and ends the run with status suspended', async () => {
    const { logger, events } = recording_logger()
    const flow = gate(step('draft', (b: string) => b), {
      id: 'approve',
      store: memory_store(),
    })

    const outcome = await run.until_suspended(flow, 'x', {
      trajectory: logger,
      install_signal_handlers: false,
    })
    expect(outcome.kind).toBe('suspended')

    const names = events.filter((e) => e.kind === 'span_start').map((e) => e['name'])
    expect(names).toContain('gate')
    expect(names).toContain('checkpoint')
    expect(names).toContain('suspend')
    expect(events.find((e) => e.kind === 'run_end')?.['status']).toBe('suspended')
  })

  it('honors a user-provided name override', async () => {
    const { logger, events } = recording_logger()
    const flow = gate(step('draft', (b: string) => b), {
      id: 'approve',
      name: 'legal_review',
    })

    const outcome = await run.until_suspended(flow, 'x', {
      trajectory: logger,
      install_signal_handlers: false,
    })
    expect(outcome.kind).toBe('suspended')

    const labels = events.filter((e) => e.kind === 'span_start').map((e) => e['name'])
    expect(labels).toContain('legal_review')
    expect(labels).not.toContain('gate')
  })

  it('throws at construction when the inner step is anonymous', () => {
    expect(() => gate(step((n: number) => n), { id: 'x' })).toThrow(
      "gate requires a named inner step, got anonymous — give the inner step an id with step('id', fn)",
    )
  })
})
