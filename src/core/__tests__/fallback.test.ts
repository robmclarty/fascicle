import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { suspended_error } from '../errors.js'
import { fallback } from '../fallback.js'
import { run } from '../runner.js'
import { step } from '../step.js'
import { suspend } from '../suspend.js'
import { recording_logger } from '../../../test/fixtures/trajectory.js'

describe('fallback', () => {
  it('runs backup with the same input when primary throws (spec §10 test 6)', async () => {
    let backup_input: number | undefined
    const primary = step('primary', (_: number) => {
      throw new Error('primary failed')
    })
    const backup = step('backup', (x: number) => {
      backup_input = x
      return `backup:${x}`
    })
  
    const flow = fallback(primary, backup)
    const result = await run(flow, 42, { install_signal_handlers: false })
  
    expect(result).toBe('backup:42')
    expect(backup_input).toBe(42)
  })

  it('runs backup with handoff(input, err) when handoff is set', async () => {
    let handoff_input: number | undefined
    let handoff_err: unknown
    let backup_input: number | undefined
    const primary = step('primary', (_: number) => {
      throw new Error('primary failed')
    })
    const backup = step('backup', (x: number) => {
      backup_input = x
      return `backup:${x}`
    })

    const flow = fallback(primary, backup, {
      handoff: (input, err) => {
        handoff_input = input
        handoff_err = err
        return input + 100
      },
    })
    const result = await run(flow, 42, { install_signal_handlers: false })

    expect(handoff_input).toBe(42)
    expect(handoff_err).toBeInstanceOf(Error)
    expect((handoff_err as Error).message).toBe('primary failed')
    expect(backup_input).toBe(142)
    expect(result).toBe('backup:142')
  })

  it('does not call handoff when primary succeeds', async () => {
    let handoff_called = false
    const primary = step('primary', (x: number) => `primary:${x}`)
    const backup = step('backup', (x: number) => `backup:${x}`)

    const flow = fallback(primary, backup, {
      handoff: (input) => {
        handoff_called = true
        return input
      },
    })
    const result = await run(flow, 1, { install_signal_handlers: false })

    expect(result).toBe('primary:1')
    expect(handoff_called).toBe(false)
  })

  it('does not call handoff on a control-flow signal', async () => {
    let handoff_called = false
    const primary = suspend({
      id: 'gate',
      on: async () => {},
      resume_schema: z.object({ ok: z.boolean() }),
      combine: (_: number, r) => (r.ok ? 1 : 0),
    })
    const backup = step('backup', (_: number) => -1)

    const flow = fallback(primary, backup, {
      handoff: (input) => {
        handoff_called = true
        return input
      },
    })

    await expect(run(flow, 0, { install_signal_handlers: false })).rejects.toBeInstanceOf(
      suspended_error,
    )
    expect(handoff_called).toBe(false)
  })

  it('returns primary result when primary succeeds', async () => {
    let backup_called = false
    const primary = step('primary', (x: number) => `primary:${x}`)
    const backup = step('backup', (x: number) => {
      backup_called = true
      return `backup:${x}`
    })
  
    const flow = fallback(primary, backup)
    const result = await run(flow, 1, { install_signal_handlers: false })
  
    expect(result).toBe('primary:1')
    expect(backup_called).toBe(false)
  })

  it('propagates backup error when both fail', async () => {
    const primary = step('primary', () => {
      throw new Error('primary failed')
    })
    const backup = step('backup', () => {
      throw new Error('backup failed')
    })

    const flow = fallback(primary, backup)
    await expect(run(flow, 0, { install_signal_handlers: false })).rejects.toThrow('backup failed')
  })

  it('attaches the primary error as the backup error cause when both fail', async () => {
    const primary_err = new Error('primary failed')
    const backup_err = new Error('backup failed')
    const primary = step('primary', () => {
      throw primary_err
    })
    const backup = step('backup', () => {
      throw backup_err
    })

    let caught: unknown
    try {
      await run(fallback(primary, backup), 0, { install_signal_handlers: false })
    } catch (err) {
      caught = err
    }

    expect(caught).toBe(backup_err)
    expect((caught as Error).cause).toBe(primary_err)
  })

  it('does not clobber a cause the backup error already carries', async () => {
    const own_cause = new Error('backup root cause')
    const backup_err = new Error('backup failed', { cause: own_cause })
    const primary = step('primary', () => {
      throw new Error('primary failed')
    })
    const backup = step('backup', () => {
      throw backup_err
    })

    let caught: unknown
    try {
      await run(fallback(primary, backup), 0, { install_signal_handlers: false })
    } catch (err) {
      caught = err
    }

    expect(caught).toBe(backup_err)
    expect((caught as Error).cause).toBe(own_cause)
  })

  it('rethrows a non-Error backup throw untouched when both fail', async () => {
    const backup_err = { code: 'EFAIL' }
    const primary = step('primary', () => {
      throw new Error('primary failed')
    })
    const backup = step('backup', () => {
      throw backup_err
    })

    let caught: unknown
    try {
      await run(fallback(primary, backup), 0, { install_signal_handlers: false })
    } catch (err) {
      caught = err
    }

    // Only Error instances can carry a cause; anything else escapes as-is.
    expect(caught).toBe(backup_err)
    expect('cause' in (caught as object)).toBe(false)
  })

  it('propagates a suspend from the backup without attaching a cause', async () => {
    const primary = step('primary', (_: number) => {
      throw new Error('primary failed')
    })
    const backup = suspend({
      id: 'backup_gate',
      on: async () => {},
      resume_schema: z.object({ ok: z.boolean() }),
      combine: (_: number, r) => (r.ok ? 1 : 0),
    })

    let caught: unknown
    try {
      await run(fallback(primary, backup), 0, { install_signal_handlers: false })
    } catch (err) {
      caught = err
    }

    // The suspend is a control-flow signal, not a failure: it must escape
    // exactly as thrown, without the both-fail cause attachment mutating it.
    expect(caught).toBeInstanceOf(suspended_error)
    expect('cause' in (caught as Error)).toBe(false)
  })

  it('wraps execution in a fallback span', async () => {
    const { logger, events } = recording_logger()
    const flow = fallback(step('p', (x: number) => x), step('b', (x: number) => x))
  
    await run(flow, 1, { trajectory: logger, install_signal_handlers: false })
  
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'fallback')
    expect(start).toBeDefined()
  })

  it('records error on span_end when both children fail', async () => {
    const { logger, events } = recording_logger()
    const flow = fallback(
      step('p', () => {
        throw new Error('p')
      }),
      step('b', () => {
        throw new Error('boom')
      }),
    )
  
    await expect(
      run(flow, 0, { trajectory: logger, install_signal_handlers: false }),
    ).rejects.toThrow('boom')
  
    const fallback_end = events.find(
      (e) => e.kind === 'span_end' && typeof e['error'] === 'string' && e['error'] === 'boom',
    )
    expect(fallback_end).toBeDefined()
  })

  it('propagates a suspend from primary without running the backup', async () => {
    let backup_called = false
    const primary = suspend({
      id: 'gate',
      on: async () => {},
      resume_schema: z.object({ ok: z.boolean() }),
      combine: (_: number, r) => (r.ok ? 1 : 0),
    })
    const backup = step('backup', (_: number) => {
      backup_called = true
      return -1
    })

    let caught: unknown
    try {
      await run(fallback(primary, backup), 0, { install_signal_handlers: false })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(suspended_error)
    expect((caught as suspended_error).suspend_id).toBe('gate')
    expect(backup_called).toBe(false)
  })

  it('resumes a suspended primary through fallback', async () => {
    const primary = suspend({
      id: 'gate',
      on: async () => {},
      resume_schema: z.object({ ok: z.boolean() }),
      combine: (_: number, r) => (r.ok ? 'approved' : 'denied'),
    })
    const backup = step('backup', (_: number) => 'backup')

    const result = await run(fallback(primary, backup), 0, {
      install_signal_handlers: false,
      resume_data: { gate: { ok: true } },
    })

    expect(result).toBe('approved')
  })
})
