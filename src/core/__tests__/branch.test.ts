import { describe, expect, it } from 'vitest'
import { branch } from '../branch.js'
import { run } from '../runner.js'
import { step } from '../step.js'
import type { TrajectoryEvent, TrajectoryLogger } from '../types.js'

function recording_logger(): { logger: TrajectoryLogger; events: TrajectoryEvent[] } {
  const events: TrajectoryEvent[] = []
  let id = 0
  const logger: TrajectoryLogger = {
    record: (event) => {
      events.push(event)
    },
    start_span: (name, meta) => {
      id += 1
      const span_id = `span_${id}`
      events.push({ kind: 'span_start', span_id, name, ...meta })
      return span_id
    },
    end_span: (span_id, meta) => {
      events.push({ kind: 'span_end', span_id, ...meta })
    },
  }
  return { logger, events }
}

const route_when = (x: number): boolean => x > 0

describe('branch', () => {
  it('routes positive inputs to then (spec §10 test 4)', async () => {
    const flow = branch({
      when: (x: number) => x > 0,
      then: step('pos', (x: number) => `pos:${x}`),
      otherwise: step('neg', (x: number) => `neg:${x}`),
    })
  
    await expect(run(flow, 5)).resolves.toBe('pos:5')
    await expect(run(flow, -3)).resolves.toBe('neg:-3')
    await expect(run(flow, 0)).resolves.toBe('neg:0')
  })

  it('supports async when predicates', async () => {
    const flow = branch({
      when: async (x: number) => Promise.resolve(x > 0),
      then: step('pos', (x: number) => `pos:${x}`),
      otherwise: step('neg', (x: number) => `neg:${x}`),
    })
  
    await expect(run(flow, 1)).resolves.toBe('pos:1')
  })

  it('emits a branch span', async () => {
    const { logger, events } = recording_logger()
    const flow = branch({
      when: (_x: number) => true,
      then: step('t', (x: number) => x),
      otherwise: step('o', (x: number) => x),
    })
  
    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })
  
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'branch')
    expect(start).toBeDefined()
  })

  it('exposes a branch step shape with id, children, and config', () => {
    const then_step = step('t', (x: number) => x)
    const otherwise_step = step('o', (x: number) => x)
    const flow = branch({ name: 'route', when: route_when, then: then_step, otherwise: otherwise_step })
    expect(flow.id).toMatch(/^branch_\d+$/)
    expect(flow.kind).toBe('branch')
    expect(flow.children).toEqual([then_step, otherwise_step])
    expect(flow.config?.['when']).toBe(route_when)
    expect(flow.config?.['then']).toBe(then_step)
    expect(flow.config?.['otherwise']).toBe(otherwise_step)
    expect(flow.config?.['display_name']).toBe('route')
  })

  it('omits display_name when no name is given', () => {
    const flow = branch({
      when: () => true,
      then: step('t', (x: number) => x),
      otherwise: step('o', (x: number) => x),
    })
    expect(flow.config !== undefined && 'display_name' in flow.config).toBe(false)
  })
})
