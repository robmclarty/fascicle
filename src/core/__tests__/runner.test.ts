import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { aborted_error, suspended_error, timeout_error } from '../errors.js'
import { run } from '../runner.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'
import { suspend } from '../suspend.js'
import { remove_signal_listeners } from '../../../test/fixtures/signal_listeners.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

describe('run()', () => {
  afterEach(remove_signal_listeners)

  it('resolves an atomic step to its output', async () => {
    await expect(run(step('id', (x: number) => x + 1), 1)).resolves.toBe(2)
  })

  it('throws on unknown step kinds', async () => {
    const bogus = {
      id: 'mystery',
      kind: 'not_registered',
      run: (x: number) => x,
    }
    await expect(run(bogus as never, 1)).rejects.toThrow(/unknown step kind/)
  })

  it('installs at most one SIGINT listener across sequential runs', async () => {
    const baseline = process.listenerCount('SIGINT')
    const s = step('noop', (x: number) => x)
  
    await run(s, 1)
    const after_first = process.listenerCount('SIGINT')
    await run(s, 1)
    const after_second = process.listenerCount('SIGINT')
  
    expect(after_first).toBeLessThanOrEqual(baseline + 1)
    expect(after_second).toBeLessThanOrEqual(baseline + 1)
  })

  it('respects install_signal_handlers: false and does not add listeners', async () => {
    const before = process.listenerCount('SIGINT')
    await run(step('noop', (x: number) => x), 0, { install_signal_handlers: false })
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('aborts an in-flight step on SIGINT and exposes aborted_error as the abort reason', async () => {
    let observed_reason: unknown = null
    let cleanup_ran = false
  
    const long_running = step('long', async (_: number, ctx) => {
      ctx.on_cleanup(() => {
        cleanup_ran = true
      })
      await new Promise<void>((_resolve, reject) => {
        const t = setTimeout(() => {
          reject(new Error('did not abort in time'))
        }, 2_000)
        ctx.abort.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            observed_reason = ctx.abort.reason
            reject(ctx.abort.reason instanceof Error ? ctx.abort.reason : new Error('aborted'))
          },
          { once: true },
        )
      })
      return 0
    })
  
    const pending = run(long_running, 0)
    await wait(20)
    process.emit('SIGINT')
  
    await expect(pending).rejects.toBeInstanceOf(aborted_error)
    expect(cleanup_ran).toBe(true)
    expect(observed_reason).toBeInstanceOf(aborted_error)
  })
})

describe('run() caller-supplied abort', () => {
  it('rejects without dispatching when the external signal is already aborted', async () => {
    const controller = new AbortController()
    const cause = new Error('cancelled before start')
    controller.abort(cause)

    let dispatched = false
    const s = step('noop', (x: number) => {
      dispatched = true
      return x
    })

    await expect(
      run(s, 1, { install_signal_handlers: false, abort: controller.signal }),
    ).rejects.toBe(cause)
    expect(dispatched).toBe(false)
  })

  it('aborts an in-flight step when the external signal fires and runs cleanup', async () => {
    const controller = new AbortController()
    const cause = new Error('external cancel')
    let cleanup_ran = false
    let observed_reason: unknown = null

    const long_running = step('long', async (_: number, ctx) => {
      ctx.on_cleanup(() => {
        cleanup_ran = true
      })
      await new Promise<void>((_resolve, reject) => {
        const t = setTimeout(() => {
          reject(new Error('did not abort in time'))
        }, 2_000)
        ctx.abort.addEventListener(
          'abort',
          () => {
            clearTimeout(t)
            observed_reason = ctx.abort.reason
            reject(ctx.abort.reason instanceof Error ? ctx.abort.reason : new Error('aborted'))
          },
          { once: true },
        )
      })
      return 0
    })

    const pending = run(long_running, 0, {
      install_signal_handlers: false,
      abort: controller.signal,
    })
    await wait(20)
    controller.abort(cause)

    await expect(pending).rejects.toBe(cause)
    expect(cleanup_ran).toBe(true)
    expect(observed_reason).toBe(cause)
  })

  it('removes its abort listener once the run settles, so a reused signal does not leak', async () => {
    const controller = new AbortController()
    const remove_spy = vi.spyOn(controller.signal, 'removeEventListener')

    await run(step('noop', (x: number) => x), 1, {
      install_signal_handlers: false,
      abort: controller.signal,
    })

    expect(remove_spy).toHaveBeenCalledTimes(1)
    // Firing the signal after the run settled is inert: the run already
    // resolved and the listener is gone.
    controller.abort(new Error('late'))
  })
})

describe('failure-aware trajectory', () => {
  it('enriches a failing span_end with error_name and error_kind', async () => {
    const { logger, events } = recording_logger()
    const boom = step('boom', () => {
      throw new timeout_error('too slow', 250)
    })

    await expect(
      run(boom, 0, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toThrow('too slow')

    const end = events.find((e) => e.kind === 'span_end' && e['error'] !== undefined)
    expect(end?.['error']).toBe('too slow')
    expect(end?.['error_name']).toBe('timeout_error')
    expect(end?.['error_kind']).toBe('timeout_error')
  })

  it('omits error_kind for plain errors but still records error_name', async () => {
    const { logger, events } = recording_logger()
    const boom = step('boom', () => {
      throw new Error('plain failure')
    })

    await expect(
      run(boom, 0, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toThrow('plain failure')

    const end = events.find((e) => e.kind === 'span_end' && e['error'] !== undefined)
    expect(end?.['error_name']).toBe('Error')
    expect(end?.['error_kind']).toBeUndefined()
  })

  it('records the accumulated error_path on enclosing span_ends', async () => {
    const { logger, events } = recording_logger()
    const flow = sequence([
      step('boom', () => {
        throw new Error('deep failure')
      }),
    ])

    await expect(
      run(flow, 0, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toThrow('deep failure')

    const sequence_end = events.find(
      (e) => e.kind === 'span_end' && e['error'] !== undefined && e['id'] !== 'boom',
    )
    expect(sequence_end?.['error_path']).toEqual(['boom'])
  })

  it('records a terminal run_end with status done as the last event', async () => {
    const { logger, events } = recording_logger()
    await run(step('ok', (n: number) => n + 1), 1, {
      trajectory: logger,
      install_signal_handlers: false,
    })

    const terminal = events[events.length - 1]
    expect(terminal?.kind).toBe('run_end')
    expect(terminal?.['status']).toBe('done')
    expect(events.filter((e) => e.kind === 'run_end')).toHaveLength(1)
  })

  it('records run_end with status failed and the error meta on a failing run', async () => {
    const { logger, events } = recording_logger()
    const boom = step('boom', () => {
      throw new timeout_error('too slow', 250)
    })

    await expect(
      run(boom, 0, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toThrow('too slow')

    const terminal = events[events.length - 1]
    expect(terminal?.kind).toBe('run_end')
    expect(terminal?.['status']).toBe('failed')
    expect(terminal?.['error']).toBe('too slow')
    expect(terminal?.['error_name']).toBe('timeout_error')
    expect(terminal?.['error_kind']).toBe('timeout_error')
  })

  it('records run_end with status aborted when the run is cancelled', async () => {
    const { logger, events } = recording_logger()
    const controller = new AbortController()
    controller.abort(new aborted_error('pre-cancelled'))

    await expect(
      run(step('never', (n: number) => n), 0, {
        trajectory: logger,
        install_signal_handlers: false,
        abort: controller.signal,
      }),
    ).rejects.toBeInstanceOf(aborted_error)

    const terminal = events[events.length - 1]
    expect(terminal?.kind).toBe('run_end')
    expect(terminal?.['status']).toBe('aborted')
    expect(terminal?.['error']).toBe('pre-cancelled')
  })

  it('records run_end with status aborted when a caller aborts with a plain cause', async () => {
    const { logger, events } = recording_logger()
    const controller = new AbortController()
    const cause = new Error('external cancel')
    controller.abort(cause)

    await expect(
      run(step('never', (n: number) => n), 0, {
        trajectory: logger,
        install_signal_handlers: false,
        abort: controller.signal,
      }),
    ).rejects.toBe(cause)

    const terminal = events[events.length - 1]
    expect(terminal?.kind).toBe('run_end')
    expect(terminal?.['status']).toBe('aborted')
  })

  it('records run_end with status suspended and the gate id when a gate fires', async () => {
    const { logger, events } = recording_logger()
    const gate = step('gate', () => {
      throw new suspended_error('editor', { awaiting: 'review' })
    })

    await expect(
      run(gate, 0, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toBeInstanceOf(suspended_error)

    const terminal = events[events.length - 1]
    expect(terminal?.kind).toBe('run_end')
    expect(terminal?.['status']).toBe('suspended')
    expect(terminal?.['suspend_id']).toBe('editor')
  })

  it('records run_end after every span_end, so it is the terminal event', async () => {
    const { logger, events } = recording_logger()
    const flow = sequence([step('a', (n: number) => n), step('b', (n: number) => n)])
    await run(flow, 0, { trajectory: logger, install_signal_handlers: false })

    const last_span_end = events.map((e) => e.kind).lastIndexOf('span_end')
    const run_end_index = events.map((e) => e.kind).indexOf('run_end')
    expect(run_end_index).toBeGreaterThan(last_span_end)
  })
})

const approval_gate = (id: string) =>
  suspend({
    id,
    on: () => {},
    resume_schema: z.object({ approved: z.boolean() }),
    combine: (input: string, resume) => `${input}:${resume.approved ? 'yes' : 'no'}`,
  })

describe('run.until_suspended', () => {
  afterEach(remove_signal_listeners)

  it('resolves { kind: "done", output } when the flow never suspends', async () => {
    const flow = step('double', (n: number) => n * 2)
    const outcome = await run.until_suspended(flow, 21, { install_signal_handlers: false })
    expect(outcome).toEqual({ kind: 'done', output: 42 })
  })

  it('reports suspension as data carrying the gate id, and resume re-runs from the top', async () => {
    let prefix_runs = 0
    const flow = sequence([
      step('prefix', (s: string) => {
        prefix_runs += 1
        return s.toUpperCase()
      }),
      approval_gate('editor'),
    ])

    const outcome = await run.until_suspended(flow, 'draft', { install_signal_handlers: false })
    expect(outcome.kind).toBe('suspended')
    if (outcome.kind !== 'suspended') throw new Error('unreachable')
    expect(outcome.id).toBe('editor')
    expect(prefix_runs).toBe(1)

    const resumed = await outcome.resume({ approved: true })
    expect(resumed).toEqual({ kind: 'done', output: 'DRAFT:yes' })
    // Resume replays from the original input: the prefix step ran again.
    expect(prefix_runs).toBe(2)
  })

  it('drives a flow with two gates by resuming twice, accumulating resume_data', async () => {
    const flow = sequence([approval_gate('first'), approval_gate('second')])

    const at_first = await run.until_suspended(flow, 'go', { install_signal_handlers: false })
    if (at_first.kind !== 'suspended') throw new Error('expected the first gate to suspend')
    expect(at_first.id).toBe('first')

    const at_second = await at_first.resume({ approved: true })
    if (at_second.kind !== 'suspended') throw new Error('expected the second gate to suspend')
    expect(at_second.id).toBe('second')

    const done = await at_second.resume({ approved: false })
    expect(done).toEqual({ kind: 'done', output: 'go:yes:no' })
  })

  it('surfaces the suspend gate payload on the suspended outcome', async () => {
    // The built-in suspend composer raises `{ input }` as its payload, so a
    // driver loop can render what awaits approval straight off the outcome.
    const outcome = await run.until_suspended(approval_gate('editor'), 'draft', {
      install_signal_handlers: false,
    })
    if (outcome.kind !== 'suspended') throw new Error('expected a suspension')
    expect(outcome.payload).toEqual({ input: 'draft' })
  })

  it('carries a custom payload raised directly on suspended_error', async () => {
    const gate = step('manual', () => {
      throw new suspended_error('manual_gate', { awaiting: 'review', doc: 'spec.md' })
    })
    const outcome = await run.until_suspended(gate, 0, { install_signal_handlers: false })
    if (outcome.kind !== 'suspended') throw new Error('expected a suspension')
    expect(outcome.id).toBe('manual_gate')
    expect(outcome.payload).toEqual({ awaiting: 'review', doc: 'spec.md' })
  })

  it('surfaces each gate payload across successive resumes', async () => {
    const flow = sequence([approval_gate('first'), approval_gate('second')])

    const at_first = await run.until_suspended(flow, 'go', { install_signal_handlers: false })
    if (at_first.kind !== 'suspended') throw new Error('expected the first gate to suspend')
    expect(at_first.payload).toEqual({ input: 'go' })

    const at_second = await at_first.resume({ approved: true })
    if (at_second.kind !== 'suspended') throw new Error('expected the second gate to suspend')
    expect(at_second.payload).toEqual({ input: 'go:yes' })
  })

  it('threads the caller options through resume', async () => {
    const events: string[] = []
    const logger = {
      record: () => {},
      start_span: (name: string) => {
        events.push(name)
        return `${name}:span`
      },
      end_span: () => {},
    }
    const flow = approval_gate('gate')
    const outcome = await run.until_suspended(flow, 'x', {
      install_signal_handlers: false,
      trajectory: logger,
    })
    if (outcome.kind !== 'suspended') throw new Error('expected a suspension')
    const spans_before_resume = events.length
    await outcome.resume({ approved: true })
    expect(spans_before_resume).toBeGreaterThan(0)
    expect(events.length).toBeGreaterThan(spans_before_resume)
  })

  it('rethrows real errors from the initial run and from resume', async () => {
    const boom = step('boom', () => {
      throw new Error('real failure')
    })
    await expect(
      run.until_suspended(boom, 'x', { install_signal_handlers: false }),
    ).rejects.toThrow('real failure')

    const failing_combine = suspend({
      id: 'gate',
      on: () => {},
      resume_schema: z.object({ approved: z.boolean() }),
      combine: () => {
        throw new Error('combine failure')
      },
    })
    const outcome = await run.until_suspended(failing_combine, 'x', {
      install_signal_handlers: false,
    })
    if (outcome.kind !== 'suspended') throw new Error('expected a suspension')
    await expect(outcome.resume({ approved: true })).rejects.toThrow('combine failure')
  })
})
