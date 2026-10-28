import { describe as describe_flow, durable, gate_result_error, run, step } from '#core'
import type { CheckpointStore, DurableStore, FlowNode, RunOutcome } from '#core'
import { describe, expect, it, vi } from 'vitest'
import { gate } from '../gate.js'
import { memory_store as durable_memory_store, type MemoryStore } from '../../../test/fixtures/memory_store.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'

const QUIET = { install_signal_handlers: false } as const

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

// A memory store whose reads throw `failure` while `failing.reads` is above
// zero, one read at a time.
function flaky_reads(failure: unknown) {
  const base = memory_store()
  const failing = { reads: 0 }
  const store: CheckpointStore & { data: Map<string, unknown> } = {
    ...base,
    async get(key) {
      if (failing.reads > 0) {
        failing.reads -= 1
        throw failure
      }
      return base.get(key)
    },
  }
  return { store, failing }
}

// What a promise rejected with, or a marker when it resolved instead.
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (err: unknown) => err,
  )
}

// The tree's kinds and the ids that an author chose, with the ids that a
// counter generated left out.
function shape(node: FlowNode): unknown {
  const generated = new RegExp(`^${node.kind}_\\d+$`).test(node.id)
  return [node.kind, generated ? null : node.id, (node.children ?? []).map(shape)]
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

  it('suspends without a store, and fails its resume with no_store rather than run inner again', async () => {
    const spy = vi.fn((n: number) => n * 2)
    const flow = gate(step('double', spy), { id: 'ok' })

    const outcome = expect_suspended(
      await run.until_suspended(flow, 21, { install_signal_handlers: false }),
    )
    expect(outcome.payload).toEqual({ input: 42 })

    // With nothing to serve what the approver saw, a resume would run inner
    // again and pass a result nobody saw.
    await expect(outcome.resume(true)).rejects.toMatchObject({
      kind: 'gate_result_error',
      suspend_id: 'ok',
      reason: 'no_store',
    })
    expect(spy).toHaveBeenCalledTimes(1)
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

  it('fails the run before it suspends when its store fails the write', async () => {
    const failure = new Error('disk full')
    const store: CheckpointStore = {
      async get() {
        return null
      },
      async set() {
        throw failure
      },
      async delete() {
        // noop
      },
    }
    const on_suspend = vi.fn()
    const flow = gate(step('draft', (n: number) => n + 1), { id: 'approve', store })
    // An approval has to refer to a result that the store kept, or a resume
    // would run the inner step again and go on with one nobody saw.
    await expect(
      run.until_suspended(flow, 1, { install_signal_handlers: false }).then(on_suspend),
    ).rejects.toBe(failure)
    expect(on_suspend).not.toHaveBeenCalled()
  })

  it.each([
    ['', '_'],
    ['approve draft', 'approve_draft'],
  ])('refuses the id %j under its own name, before its suspend sees it', (id, suggested) => {
    const build = () => gate(step('draft', (n: number) => n), { id })
    expect(build).toThrow(TypeError)
    expect(build).toThrow(
      `gate id ${JSON.stringify(id)} is not a valid identifier: ids are read back as property names, so use ${suggested} and put the label in name`,
    )
  })

  it('throws at construction when the inner step is anonymous', () => {
    expect(() => gate(step((n: number) => n), { id: 'x' })).toThrow(
      "gate requires a named inner step, got anonymous — give the inner step an id with step('id', fn)",
    )
  })
})

describe('gate on a resume', () => {
  it('fails with read_error when its store fails the read, without running inner again or touching the result', async () => {
    const failure = new Error('disk unavailable')
    const { store, failing } = flaky_reads(failure)
    let drafts = 0
    const spy = vi.fn((brief: string) => {
      drafts += 1
      return `draft ${drafts} of ${brief}`
    })
    const flow = gate(step('draft', spy), { id: 'approve', store })
    const suspended = expect_suspended(await run.until_suspended(flow, 'launch', QUIET))

    failing.reads = 1
    const err = await rejection(suspended.resume({ approved: true }))
    expect(err).toMatchObject({ kind: 'gate_result_error', suspend_id: 'approve', reason: 'read_error' })
    expect(err).toBeInstanceOf(gate_result_error)
    expect((err as Error).cause).toBe(failure)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(store.data.get('gate:approve')).toBe('draft 1 of launch')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('fails with missing when its store lost the result and reads back %s, and never runs inner on the resume', async (_, lost) => {
    const base = memory_store()
    const store = {
      ...base,
      get: async (key: string) => (base.data.has(key) ? base.data.get(key) : lost),
    }
    const spy = vi.fn((brief: string) => `draft of ${brief}`)
    const flow = gate(step('draft', spy), { id: 'approve', store })
    const suspended = expect_suspended(await run.until_suspended(flow, 'launch', QUIET))

    store.data.delete('gate:approve')
    await expect(suspended.resume({ approved: true })).rejects.toMatchObject({
      kind: 'gate_result_error',
      suspend_id: 'approve',
      reason: 'missing',
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(store.data.has('gate:approve')).toBe(false)
  })

  it('still runs inner, writes, and suspends on a first run whose store fails the read', async () => {
    const { store, failing } = flaky_reads(new Error('disk unavailable'))
    const spy = vi.fn((brief: string) => `draft of ${brief}`)
    const flow = gate(step('draft', spy), { id: 'approve', store })

    failing.reads = 1
    const suspended = expect_suspended(await run.until_suspended(flow, 'launch', QUIET))
    expect(suspended.payload).toEqual({ input: 'draft of launch' })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(store.data.get('gate:approve')).toBe('draft of launch')
  })

  it('fails with missing when handed its datum on a first run over an empty store, and never runs inner', async () => {
    const store = memory_store()
    const spy = vi.fn((brief: string) => `draft of ${brief}`)
    const flow = gate(step('draft', spy), { id: 'approve' })

    await expect(
      run(flow, 'launch', { ...QUIET, checkpoint_store: store, resume_data: { approve: true } }),
    ).rejects.toMatchObject({ kind: 'gate_result_error', suspend_id: 'approve', reason: 'missing' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('suspends on a first run whose resume data holds undefined for it', async () => {
    const store = memory_store()
    const spy = vi.fn((brief: string) => `draft of ${brief}`)
    const flow = gate(step('draft', spy), { id: 'approve', store })

    const outcome = await run.until_suspended(flow, 'launch', { ...QUIET, resume_data: { approve: undefined } })
    expect(expect_suspended(outcome).payload).toEqual({ input: 'draft of launch' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('suspends on a first run when its id names an Object.prototype member that the resume data inherits', async () => {
    const store = memory_store()
    const spy = vi.fn((brief: string) => `draft of ${brief}`)
    const flow = gate(step('draft', spy), { id: 'constructor', store })

    const outcome = await run.until_suspended(flow, 'launch', { ...QUIET, resume_data: { other: true } })
    expect(expect_suspended(outcome).id).toBe('constructor')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('leaves a durable run failed when its store fails one read, and finishes it on the next resume with the stored result', async () => {
    const failure = new Error('disk unavailable')
    const failing = { reads: 0 }
    type Scope = ReturnType<MemoryStore['scope']>
    const flaky = (scope: Scope): Scope => ({
      ...scope,
      get: async (key) => {
        if (key === 'gate:approve' && failing.reads > 0) {
          failing.reads -= 1
          throw failure
        }
        return scope.get(key)
      },
      scope: (prefix) => flaky(scope.scope(prefix)),
    })
    const base = durable_memory_store()
    const store: DurableStore = { scope: (prefix) => flaky(base.scope(prefix)) }
    const runs = durable({ store })
    const spy = vi.fn((brief: string) => `draft of ${brief}`)
    const flow = gate(step('draft', spy), { id: 'approve' })

    expect(await runs.start('r', flow, 'launch', QUIET)).toMatchObject({
      kind: 'suspended',
      id: 'approve',
      payload: { input: 'draft of launch' },
    })
    failing.reads = 1
    await expect(runs.resume('r', flow, { approve: true }, QUIET)).rejects.toMatchObject({
      kind: 'gate_result_error',
      reason: 'read_error',
    })
    expect(await runs.get('r')).toMatchObject({ kind: 'failed', run_id: 'r' })
    // The approval is still in the run's resume data, so the next resume with
    // nothing new serves the result that the approver saw.
    expect(await runs.resume('r', flow, {}, QUIET)).toEqual({
      kind: 'done',
      run_id: 'r',
      output: 'draft of launch',
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['hit', 'a gate-local store', true],
    ['read_error', 'a gate-local store', true],
    ['miss', 'a gate-local store', true],
    ['hit', 'the run store', false],
    ['read_error', 'the run store', false],
    ['miss', 'the run store', false],
  ] as const)('records one checkpoint event for a lookup that ends in a %s over %s', async (status, _, local) => {
    const { store, failing } = flaky_reads(new Error('disk unavailable'))
    const flow = gate(step('draft', (brief: string) => `draft of ${brief}`), {
      id: 'approve',
      ...(local ? { store } : {}),
    })
    const options = local ? QUIET : { ...QUIET, checkpoint_store: store }
    expect_suspended(await run.until_suspended(flow, 'launch', options))

    if (status === 'read_error') failing.reads = 1
    if (status === 'miss') store.data.delete('gate:approve')
    const { logger, events } = recording_logger()
    const resumed = rejection(
      run(flow, 'launch', { ...options, trajectory: logger, resume_data: { approve: true } }),
    )
    if (status === 'hit') {
      expect(await resumed).toBe('resolved')
    } else {
      expect(await resumed).toMatchObject({
        kind: 'gate_result_error',
        reason: status === 'miss' ? 'missing' : 'read_error',
      })
    }

    const checkpoint_id = find_node(describe_flow.json(flow), (n) => n.kind === 'checkpoint')?.id
    const span = events.find((e) => e.kind === 'span_start' && e['name'] === 'checkpoint')
    const recorded = events
      .filter((e) => e.kind === 'checkpoint')
      .map(({ run_id: _run_id, ts: _ts, ...rest }) => rest)
    expect(recorded).toStrictEqual([
      {
        kind: 'checkpoint',
        status,
        ...(status === 'read_error' ? { error: 'disk unavailable' } : {}),
        id: checkpoint_id,
        key: 'gate:approve',
        span_id: span?.['span_id'],
      },
    ])
  })

  it.each([
    ['without a store', false],
    ['with a gate-local store', true],
  ])('keeps the tree that describe shows %s', (_, local) => {
    const flow = gate(step('draft', (brief: string) => brief), {
      id: 'approve',
      ...(local ? { store: memory_store() } : {}),
    })
    const persisted = [['checkpoint', null, [['step', 'draft', []]]]]
    expect(shape(describe_flow.json(flow))).toStrictEqual([
      'compose',
      null,
      [
        [
          'scope',
          null,
          [
            ['stash', null, local ? [['step', 'bind_store', persisted]] : persisted],
            ['step', 'project_payload', []],
            ['suspend', 'approve', []],
          ],
        ],
      ],
    ])
  })
})
