import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { step } from '#core'
import { execute_stdio } from '../execute_stdio.js'
import type { StdioIo, StdioOutcome } from '../execute_stdio.js'

const echo = step('echo', (input: { readonly topic: string }) => ({ headline: input.topic }))

type FakeIo = StdioIo & {
  readonly stdout_writes: string[]
  readonly stderr_text: () => string
}

function fake_io(stdin: string, overrides: Partial<StdioIo> = {}): FakeIo {
  const stdout_writes: string[] = []
  let stderr = ''
  return {
    read_input: () => Promise.resolve(stdin),
    write_output: (text) => {
      stdout_writes.push(text)
      return Promise.resolve()
    },
    error_stream: {
      write: (chunk: string) => {
        stderr += chunk
        return true
      },
    },
    ...overrides,
    stdout_writes,
    stderr_text: () => stderr,
  }
}

function expect_failed(outcome: StdioOutcome): Extract<StdioOutcome, { code: 1 | 2 }> {
  expect(outcome.code).not.toBe(0)
  if (outcome.code === 0) throw new Error('expected a failed outcome')
  return outcome
}

describe('execute_stdio', () => {
  it('writes exactly one JSON document to stdout and returns code 0', async () => {
    const io = fake_io(JSON.stringify({ topic: 'tests' }))
    const outcome = await execute_stdio(echo, {}, io)

    expect(outcome).toEqual({ code: 0 })
    expect(io.stdout_writes).toEqual([`${JSON.stringify({ headline: 'tests' })}\n`])
  })

  it('returns 2/read when reading stdin fails', async () => {
    const io = fake_io('', { read_input: () => Promise.reject(new Error('stream closed')) })
    const outcome = expect_failed(await execute_stdio(echo, {}, io))

    expect(outcome.code).toBe(2)
    expect(outcome.failure).toMatchObject({ error: 'stream closed', stage: 'read' })
    expect(io.stdout_writes).toEqual([])
  })

  it('returns 2/parse for unparseable stdin, with no stdout', async () => {
    const io = fake_io('not json')
    const outcome = expect_failed(await execute_stdio(echo, {}, io))

    expect(outcome.code).toBe(2)
    expect(outcome.failure.stage).toBe('parse')
    expect(io.stdout_writes).toEqual([])
  })

  it('returns 2/validate_input with zod issues in cause when input fails the schema', async () => {
    const io = fake_io(JSON.stringify({ topic: 42 }))
    const outcome = expect_failed(
      await execute_stdio(echo, { input_schema: z.object({ topic: z.string() }) }, io),
    )

    expect(outcome.code).toBe(2)
    expect(outcome.failure.stage).toBe('validate_input')
    expect(outcome.failure.cause).toEqual([
      expect.objectContaining({ code: 'invalid_type', path: ['topic'] }),
    ])
    expect(io.stdout_writes).toEqual([])
  })

  it('passes the schema-transformed input to the flow', async () => {
    const io = fake_io(JSON.stringify({ topic: '  tests  ' }))
    const input_schema = z.object({ topic: z.string().transform((s) => s.trim()) })
    const outcome = await execute_stdio(echo, { input_schema }, io)

    expect(outcome).toEqual({ code: 0 })
    expect(io.stdout_writes).toEqual([`${JSON.stringify({ headline: 'tests' })}\n`])
  })

  it('returns 1/run when the flow throws, and still disposes the engine', async () => {
    const boom = step('boom', () => {
      throw new Error('flow exploded')
    })
    const dispose = vi.fn(() => Promise.resolve())
    const io = fake_io('{}')
    const outcome = expect_failed(await execute_stdio(boom, { engine: { dispose } }, io))

    expect(outcome.code).toBe(1)
    expect(outcome.failure).toMatchObject({ error: 'flow exploded', stage: 'run' })
    expect(outcome.failure.cause).toMatchObject({ name: 'Error', path: ['boom'] })
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(io.stdout_writes).toEqual([])
  })

  it('returns 1/run for a pre-aborted signal', async () => {
    const io = fake_io('{}')
    const outcome = expect_failed(
      await execute_stdio(echo, { abort: AbortSignal.abort(new Error('parent gone')) }, io),
    )

    expect(outcome.code).toBe(1)
    expect(outcome.failure.stage).toBe('run')
    expect(io.stdout_writes).toEqual([])
  })

  it('returns 2/validate_output when the result fails the schema', async () => {
    const io = fake_io(JSON.stringify({ topic: 'tests' }))
    const outcome = expect_failed(
      await execute_stdio(echo, { output_schema: z.object({ headline: z.string().min(100) }) }, io),
    )

    expect(outcome.code).toBe(2)
    expect(outcome.failure.stage).toBe('validate_output')
    expect(io.stdout_writes).toEqual([])
  })

  it('serializes the schema-validated output so transforms apply', async () => {
    const io = fake_io(JSON.stringify({ topic: 'tests' }))
    const output_schema = z.object({ headline: z.string().transform((s) => s.toUpperCase()) })
    const outcome = await execute_stdio(echo, { output_schema }, io)

    expect(outcome).toEqual({ code: 0 })
    expect(io.stdout_writes).toEqual([`${JSON.stringify({ headline: 'TESTS' })}\n`])
  })

  it('returns 2/serialize for a circular result', async () => {
    const circular = step('circular', () => {
      const value: Record<string, unknown> = {}
      value['self'] = value
      return value
    })
    const io = fake_io('{}')
    const outcome = expect_failed(await execute_stdio(circular, {}, io))

    expect(outcome.code).toBe(2)
    expect(outcome.failure.stage).toBe('serialize')
    expect(io.stdout_writes).toEqual([])
  })

  it('returns 2/serialize for an undefined result', async () => {
    const nothing = step('nothing', () => undefined)
    const io = fake_io('{}')
    const outcome = expect_failed(await execute_stdio(nothing, {}, io))

    expect(outcome.code).toBe(2)
    expect(outcome.failure).toEqual({
      error: 'flow result is not JSON-serializable',
      stage: 'serialize',
    })
    expect(io.stdout_writes).toEqual([])
  })

  it('disposes before writing stdout; a dispose failure on success yields 1/dispose and no stdout', async () => {
    const order: string[] = []
    const io = fake_io(JSON.stringify({ topic: 'tests' }), {
      write_output: () => {
        order.push('stdout')
        return Promise.resolve()
      },
    })
    const good = await execute_stdio(
      echo,
      {
        engine: {
          dispose: () => {
            order.push('dispose')
            return Promise.resolve()
          },
        },
      },
      io,
    )
    expect(good).toEqual({ code: 0 })
    expect(order).toEqual(['dispose', 'stdout'])

    const bad_io = fake_io(JSON.stringify({ topic: 'tests' }))
    const bad = expect_failed(
      await execute_stdio(
        echo,
        { engine: { dispose: () => Promise.reject(new Error('teardown failed')) } },
        bad_io,
      ),
    )
    expect(bad.code).toBe(1)
    expect(bad.failure).toMatchObject({ error: 'teardown failed', stage: 'dispose' })
    expect(bad_io.stdout_writes).toEqual([])
  })

  it('a dispose failure never masks an earlier failure', async () => {
    const io = fake_io('not json')
    const outcome = expect_failed(
      await execute_stdio(
        echo,
        { engine: { dispose: () => Promise.reject(new Error('teardown failed')) } },
        io,
      ),
    )

    expect(outcome.code).toBe(2)
    expect(outcome.failure.stage).toBe('parse')
  })

  it('returns 1/write when the stdout write fails', async () => {
    const io = fake_io(JSON.stringify({ topic: 'tests' }), {
      write_output: () => Promise.reject(new Error('broken pipe')),
    })
    const outcome = expect_failed(await execute_stdio(echo, {}, io))

    expect(outcome.code).toBe(1)
    expect(outcome.failure).toMatchObject({ error: 'broken pipe', stage: 'write' })
  })

  it('defaults trajectory to a stderr_logger on the injected error stream', async () => {
    const io = fake_io(JSON.stringify({ topic: 'tests' }))
    await execute_stdio(echo, {}, io)

    const lines = io
      .stderr_text()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l): Record<string, unknown> => JSON.parse(l) as Record<string, unknown>)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((l) => l['kind'] === 'span_start')).toBe(true)
  })

  it('an explicit trajectory leaves the error stream untouched', async () => {
    const start_span = vi.fn(() => 'id')
    const io = fake_io(JSON.stringify({ topic: 'tests' }))
    await execute_stdio(
      echo,
      { trajectory: { record: () => {}, start_span, end_span: () => {} } },
      io,
    )

    expect(io.stderr_text()).toBe('')
    expect(start_span).toHaveBeenCalled()
  })
})
