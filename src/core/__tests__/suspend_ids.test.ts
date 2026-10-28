import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { branch } from '../branch.js'
import { durable } from '../durable.js'
import { duplicate_suspend_id_error } from '../errors.js'
import { parallel } from '../parallel.js'
import { run } from '../runner.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'
import { suspend } from '../suspend.js'
import type { AnyStep, Step } from '../types.js'
import { memory_store } from '../../../test/fixtures/memory_store.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'

const QUIET = { install_signal_handlers: false } as const

function approval(id = 'approve'): Step<string, string> {
  return suspend({ id, on: () => {}, resume_schema: z.boolean(), combine: (input: string) => input })
}

// What a promise rejected with, or a marker when it resolved instead.
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (err: unknown) => err,
  )
}

const KEYED_BY_ID = 'resume data is keyed by id, so give each suspend and gate an id of its own'

describe('a flow that holds one suspend id in two places', () => {
  it('is refused in a sequence before any step runs, naming each place by its position', async () => {
    const front = vi.fn((s: string) => s)
    const flow = sequence([step('front', front), approval(), step('middle', (s: string) => s), approval()])

    const err = await rejection(run(flow, 'in', QUIET))
    expect(err).toMatchObject({
      kind: 'duplicate_suspend_id_error',
      suspend_id: 'approve',
      reason: 'declared_twice',
      paths: [
        [flow.id, 'approve'],
        [flow.id, 'approve'],
      ],
    })
    expect(err).toBeInstanceOf(duplicate_suspend_id_error)
    expect((err as Error).message).toBe(
      `suspend id "approve" is used in 2 places (${flow.id} > approve (step 2), ${flow.id} > approve (step 4)): ${KEYED_BY_ID}`,
    )
    expect(front).not.toHaveBeenCalled()
  })

  it('is refused in a parallel before any step runs', async () => {
    const front = vi.fn((s: string) => s)
    const fan = parallel({ left: approval(), right: approval() })
    const flow = sequence([step('front', front), fan])

    const err = await rejection(run(flow, 'in', QUIET))
    expect(err).toMatchObject({
      reason: 'declared_twice',
      paths: [
        [flow.id, fan.id, 'approve'],
        [flow.id, fan.id, 'approve'],
      ],
    })
    expect((err as Error).message).toBe(
      `suspend id "approve" is used in 2 places (${flow.id} > ${fan.id} > approve (step 1), ${flow.id} > ${fan.id} > approve (step 2)): ${KEYED_BY_ID}`,
    )
    expect(front).not.toHaveBeenCalled()
  })

  it('is refused in two arms of a branch, and says that a resume replays the condition', async () => {
    const front = vi.fn((s: string) => s)
    const fork = branch({ when: () => true, then: approval(), otherwise: approval() })
    const flow = sequence([step('front', front), fork])

    const err = await rejection(run(flow, 'in', QUIET))
    expect(err).toMatchObject({
      reason: 'declared_twice',
      paths: [
        [flow.id, fork.id, 'approve'],
        [flow.id, fork.id, 'approve'],
      ],
    })
    expect((err as Error).message).toBe(
      `suspend id "approve" is used in 2 places (${flow.id} > ${fork.id} > approve (step 1), ${flow.id} > ${fork.id} > approve (step 2)): ${KEYED_BY_ID}; only one arm of a branch runs, but a resume replays its condition, so each arm's gate needs an id of its own`,
    )
    expect(front).not.toHaveBeenCalled()
  })

  it('gives the branch advice when two of three places part at a branch', async () => {
    const fork = branch({ when: () => true, then: approval(), otherwise: approval() })
    const flow = sequence([approval(), fork])

    const err = await rejection(run(flow, 'in', QUIET))
    expect((err as Error).message).toBe(
      `suspend id "approve" is used in 3 places (${flow.id} > approve, ${flow.id} > ${fork.id} > approve (step 1), ${flow.id} > ${fork.id} > approve (step 2)): ${KEYED_BY_ID}; only one arm of a branch runs, but a resume replays its condition, so each arm's gate needs an id of its own`,
    )
  })

  it('counts one suspend value placed twice in each place', async () => {
    const front = vi.fn((s: string) => s)
    const once = approval()
    const flow = sequence([step('front', front), once, once])

    const err = await rejection(run(flow, 'in', QUIET))
    expect(err).toMatchObject({ reason: 'declared_twice', suspend_id: 'approve' })
    expect((err as Error).message).toContain(`${flow.id} > approve (step 2), ${flow.id} > approve (step 3)`)
    expect(front).not.toHaveBeenCalled()
  })

  it('counts one subtree placed twice in each place, and marks where the two part', async () => {
    const shared = sequence([approval()])
    const fan = parallel({ left: shared, right: shared })
    const flow = sequence([step('front', (s: string) => s), fan])

    const err = await rejection(run(flow, 'in', QUIET))
    expect((err as Error).message).toBe(
      `suspend id "approve" is used in 2 places (${flow.id} > ${fan.id} > ${shared.id} (step 1) > approve, ${flow.id} > ${fan.id} > ${shared.id} (step 2) > approve): ${KEYED_BY_ID}`,
    )
  })

  it('names each place by its ids alone when no two read the same', async () => {
    const inner = sequence([approval()])
    const flow = sequence([approval(), inner])

    const err = await rejection(run(flow, 'in', QUIET))
    expect((err as Error).message).toBe(
      `suspend id "approve" is used in 2 places (${flow.id} > approve, ${flow.id} > ${inner.id} > approve): ${KEYED_BY_ID}`,
    )
  })

  it('counts a suspend inside a hand-built suspend that holds it, under the same id', async () => {
    const inner = approval()
    const outer: Step<string, string> = { ...approval(), children: [inner] }

    const err = await rejection(run(outer, 'in', QUIET))
    expect((err as Error).message).toBe(
      `suspend id "approve" is used in 2 places (approve, approve > approve): ${KEYED_BY_ID}`,
    )
  })

  it('refuses the first id in flow order that sits in two places', async () => {
    const flow = sequence([approval('first'), approval('second'), approval('second'), approval('first')])

    await expect(run(flow, 'in', QUIET)).rejects.toMatchObject({
      reason: 'declared_twice',
      suspend_id: 'first',
    })
  })

  it.each(['run', 'run.stream', 'run.until_suspended'] as const)(
    'is refused through %s, which ends the run failed with the error kind',
    async (entry) => {
      const { logger, events } = recording_logger()
      const front = vi.fn((s: string) => s)
      const flow = sequence([step('front', front), approval(), approval()])
      const options = { ...QUIET, trajectory: logger }
      const result =
        entry === 'run'
          ? run(flow, 'in', options)
          : entry === 'run.stream'
            ? run.stream(flow, 'in', options).result
            : run.until_suspended(flow, 'in', options)

      await expect(result).rejects.toBeInstanceOf(duplicate_suspend_id_error)
      expect(front).not.toHaveBeenCalled()
      expect(events.find((e) => e.kind === 'run_end')).toMatchObject({
        status: 'failed',
        error_kind: 'duplicate_suspend_id_error',
      })
    },
  )

  it("makes durable's start reject with the refusal", async () => {
    const runs = durable({ store: memory_store() })
    const flow = sequence([approval(), approval()])

    await expect(runs.start('r', flow, 'in', QUIET)).rejects.toBeInstanceOf(duplicate_suspend_id_error)
  })
})

describe('a flow whose suspend ids are distinct', () => {
  it('runs as before', async () => {
    const flow = sequence([approval('first'), approval('second')])

    const outcome = await run.until_suspended(flow, 'in', QUIET)
    expect(outcome).toMatchObject({ kind: 'suspended', id: 'first' })
    expect(await run(flow, 'in', { ...QUIET, resume_data: { first: true, second: true } })).toBe('in')
  })

  it('is walked once however often it runs', async () => {
    let reads = 0
    const leaf = step('leaf', (s: string) => s)
    const root: Step<string, string> = {
      id: 'root',
      kind: 'step',
      run: (s: string) => s,
      get children() {
        reads += 1
        return [leaf]
      },
    }

    await run(root, 'in', QUIET)
    await run(root, 'in', QUIET)
    expect(reads).toBe(1)
  })

  it('walks a step tree that holds itself without hanging', async () => {
    const children: AnyStep[] = []
    const cyclic: Step<number, number> = { id: 'cyclic', kind: 'step', run: (n: number) => n, children }
    children.push(cyclic)

    expect(await run(cyclic, 1, QUIET)).toBe(1)
  })
})
