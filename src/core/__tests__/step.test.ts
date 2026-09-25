import { describe, expect, it } from 'vitest'
import { recording_logger } from '../../../test/fixtures/trajectory.js'
import { run } from '../runner.js'
import { step } from '../step.js'

describe('step', () => {
  it('runs an atomic step via the runner', async () => {
    const s = step('inc', (x: number) => x + 1)
    await expect(run(s, 1)).resolves.toBe(2)
  })

  it('supports async step functions', async () => {
    const s = step('doubled', async (x: number) => x * 2)
    await expect(run(s, 5)).resolves.toBe(10)
  })

  it('assigns step_<n> ids to anonymous steps', () => {
    const anon = step((x: number) => x)
    expect(anon.id).toMatch(/^step_\d+$/)
    expect(anon.anonymous).toBe(true)
  })

  it('marks named steps as non-anonymous', () => {
    const named = step('n', (x: number) => x)
    expect(named.anonymous).toBeFalsy()
    expect(named.id).toBe('n')
  })

  it('assigns distinct, monotonically increasing ids for anonymous steps', () => {
    const a = step((x: number) => x)
    const b = step((x: number) => x)
    expect(a.id).not.toBe(b.id)
    const a_n = Number.parseInt(a.id.slice('step_'.length), 10)
    const b_n = Number.parseInt(b.id.slice('step_'.length), 10)
    expect(b_n).toBeGreaterThan(a_n)
  })

  it('runs an anonymous step identically to a named one', async () => {
    const anon = step((x: number) => x + 1)
    const named = step('inc', (x: number) => x + 1)
    await expect(run(anon, 41)).resolves.toBe(42)
    await expect(run(named, 41)).resolves.toBe(42)
  })

  it('rejects an id that is not identifier-shaped', () => {
    expect(() => step('this is my id', (x: number) => x)).toThrow(
      'step id "this is my id" is not a valid identifier: ids are read back as property names, so use this_is_my_id and put the label in meta.name',
    )
  })

  it('rejects an empty id', () => {
    expect(() => step('', (x: number) => x)).toThrow(TypeError)
  })

  it('accepts the prose spelling in meta.name instead', () => {
    const s = step('this_is_my_id', (x: number) => x, { name: 'this is my id' })
    expect(s.id).toBe('this_is_my_id')
    expect(s.meta?.name).toBe('this is my id')
  })

  it('checks the fn before the id, so the worse mistake reports first', () => {
    expect(() => step('bad id', undefined as unknown as (x: number) => number)).toThrow(
      'step(id, fn): fn must be a function',
    )
  })

  it('throws when a non-function is passed as the step fn', () => {
    expect(() => step('bad', undefined as unknown as (x: number) => number)).toThrow(TypeError)
  })

  it('attaches optional metadata when supplied as the third argument', () => {
    const labelled = step('inc', (x: number) => x + 1, {
      name: 'Increment',
      description: 'Adds one to its input',
      port_labels: { in: 'count', out: 'count + 1' },
    })
    expect(labelled.meta).toEqual({
      name: 'Increment',
      description: 'Adds one to its input',
      port_labels: { in: 'count', out: 'count + 1' },
    })
  })

  it('omits meta when not supplied', () => {
    const plain = step('p', (x: number) => x)
    expect(plain.meta).toBeUndefined()
  })

  it('labels its trajectory span with meta.name when supplied', async () => {
    const { logger, events } = recording_logger()
    const flow = step('inc', (x: number) => x + 1, { name: 'Increment' })

    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })

    const start = events.find((e) => e.kind === 'span_start')
    expect(start?.['name']).toBe('Increment')
    expect(start?.['id']).toBe('inc')
  })

  it('labels its trajectory span with the kind when meta carries no name', async () => {
    const { logger, events } = recording_logger()
    const flow = step('inc', (x: number) => x + 1, { description: 'Adds one' })

    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })

    const start = events.find((e) => e.kind === 'span_start')
    expect(start?.['name']).toBe('step')
    expect(start?.['id']).toBe('inc')
  })

  it('records a declared arm as its only child and leaves it out of meta', () => {
    const arm = step('inner', (x: number) => x * 10)
    const outer = step('outer', (x: number) => x, { description: 'calls inner', arm })
    expect(outer.children).toEqual([arm])
    expect(outer.meta).toEqual({ description: 'calls inner' })
  })

  it('records several declared arms in order', () => {
    const first = step('first', (x: number) => x)
    const second = step('second', (x: number) => x)
    const outer = step('outer', (x: number) => x, { arm: [first, second] })
    expect(outer.children).toEqual([first, second])
  })

  it('carries no meta when the options hold only an arm, and no children without one', () => {
    const arm = step('inner', (x: number) => x)
    expect(step('outer', (x: number) => x, { arm })).not.toHaveProperty('meta')
    expect(step('plain', (x: number) => x, { name: 'Plain' })).not.toHaveProperty('children')
  })

  it('never dispatches a declared arm itself: the body decides', async () => {
    let arm_runs = 0
    const arm = step('inner', (x: number) => {
      arm_runs += 1
      return x
    })
    const silent = step('silent', (x: number) => x + 1, { arm })
    await expect(run(silent, 1)).resolves.toBe(2)
    expect(arm_runs).toBe(0)
    const calling = step('calling', (x: number, ctx) => ctx.call(arm, x), { arm })
    await expect(run(calling, 5)).resolves.toBe(5)
    expect(arm_runs).toBe(1)
  })
})
