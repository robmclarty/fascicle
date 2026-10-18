import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, step } from '#core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { filesystem_logger } from '../filesystem_logger.js'

let work_dir = ''

beforeEach(() => {
  work_dir = mkdtempSync(join(tmpdir(), 'fascicle-fs-logger-'))
})

afterEach(() => {
  rmSync(work_dir, { recursive: true, force: true })
})

function read_lines(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, 'utf8')
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l): Record<string, unknown> => JSON.parse(l) as Record<string, unknown>)
}

describe('filesystem_logger', () => {
  it('appends each record as one JSON object per line', () => {
    const output_path = join(work_dir, 'trajectory.jsonl')
    const logger = filesystem_logger({ output_path })
  
    logger.record({ kind: 'emit', text: 'hello' })
    logger.record({ kind: 'emit', text: 'world' })
  
    const lines = read_lines(output_path)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({ kind: 'emit', text: 'hello' })
    expect(lines[1]).toEqual({ kind: 'emit', text: 'world' })
  })

  it('emits span_start and span_end for each start/end call', () => {
    const output_path = join(work_dir, 'trajectory.jsonl')
    const logger = filesystem_logger({ output_path })
  
    const id = logger.start_span('step', { id: 'a' })
    logger.end_span(id, { id: 'a' })
  
    const lines = read_lines(output_path)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ kind: 'span_start', span_id: id, name: 'step', id: 'a' })
    expect(lines[1]).toMatchObject({ kind: 'span_end', span_id: id, id: 'a' })
  })

  it('nested sequential spans carry parent_span_id on the child', () => {
    const output_path = join(work_dir, 'trajectory.jsonl')
    const logger = filesystem_logger({ output_path })
  
    const outer = logger.start_span('sequence', { id: 'seq_1' })
    const inner = logger.start_span('step', { id: 'a' })
    logger.end_span(inner, { id: 'a' })
    logger.end_span(outer, { id: 'seq_1' })
  
    const lines = read_lines(output_path)
    const outer_start = lines.find((l) => l['span_id'] === outer && l['kind'] === 'span_start')
    const inner_start = lines.find((l) => l['span_id'] === inner && l['kind'] === 'span_start')
  
    expect(outer_start?.['parent_span_id']).toBeUndefined()
    expect(inner_start?.['parent_span_id']).toBe(outer)
  })

  it('prefers a caller-supplied parent_span_id over the open-span stack', () => {
    const output_path = join(work_dir, 'trajectory.jsonl')
    const logger = filesystem_logger({ output_path })

    // Outer is open, so the stack would name it as parent; the explicit
    // parent_span_id in meta must win (this is how the runner threads the true
    // structural parent for concurrent children under parallel/map).
    const outer = logger.start_span('parallel', { id: 'par_1' })
    const child = logger.start_span('step', { id: 'a', parent_span_id: 'real-parent' })
    logger.end_span(child, { id: 'a' })
    logger.end_span(outer, { id: 'par_1' })

    const lines = read_lines(output_path)
    const child_start = lines.find((l) => l['span_id'] === child && l['kind'] === 'span_start')
    expect(child_start?.['parent_span_id']).toBe('real-parent')
    expect(child_start?.['parent_span_id']).not.toBe(outer)
  })

  it('creates the output directory if missing', () => {
    const nested_path = join(work_dir, 'a', 'b', 'c', 'out.jsonl')
    const logger = filesystem_logger({ output_path: nested_path })
    logger.record({ kind: 'ping' })
    const lines = read_lines(nested_path)
    expect(lines).toEqual([{ kind: 'ping' }])
  })

  it('two distinct logger instances (distinct paths) do not share state', () => {
    const path_a = join(work_dir, 'a.jsonl')
    const path_b = join(work_dir, 'b.jsonl')
    const logger_a = filesystem_logger({ output_path: path_a })
    const logger_b = filesystem_logger({ output_path: path_b })
  
    logger_a.record({ kind: 'from_a' })
    logger_b.record({ kind: 'from_b' })
  
    expect(read_lines(path_a)).toEqual([{ kind: 'from_a' }])
    expect(read_lines(path_b)).toEqual([{ kind: 'from_b' }])
  })

  it('hands an event it cannot serialize to on_error and keeps logging', () => {
    const output_path = join(work_dir, 'trajectory.jsonl')
    const errors: unknown[] = []
    const logger = filesystem_logger({ output_path, on_error: (err) => errors.push(err) })

    expect(() => logger.record({ kind: 'emit', count: 1n })).not.toThrow()
    logger.record({ kind: 'emit', text: 'after' })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(TypeError)
    expect(read_lines(output_path)).toEqual([{ kind: 'emit', text: 'after' }])
  })

  it('hands a failed append to on_error', () => {
    const errors: unknown[] = []
    const logger = filesystem_logger({ output_path: work_dir, on_error: (err) => errors.push(err) })

    expect(() => logger.record({ kind: 'emit', text: 'lost' })).not.toThrow()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'EISDIR' })
  })

  it('writes one stderr line per failure without an on_error', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const logger = filesystem_logger({ output_path: work_dir })
      logger.record({ kind: 'emit', text: 'lost' })
      logger.record({ kind: 'emit', count: 1n })

      expect(spy).toHaveBeenCalledTimes(2)
      const [append_line, serialize_line] = spy.mock.calls.map((c) => String(c[0]))
      expect(append_line).toMatch(
        new RegExp(`^filesystem_logger: dropped an event it could not write to ${work_dir} \\(EISDIR`),
      )
      expect(append_line).toContain(
        'Check that the path is a writable file and that every emitted value is JSON-serializable.\n',
      )
      expect(serialize_line).toContain('(Do not know how to serialize a BigInt)')
    } finally {
      spy.mockRestore()
    }
  })

  it('reports a thrown non-Error as its string', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const logger = filesystem_logger({ output_path: join(work_dir, 'trajectory.jsonl') })
      logger.record({
        kind: 'emit',
        value: {
          toJSON: () => {
            throw 'not an error'
          },
        },
      })
      expect(String(spy.mock.calls[0]?.[0])).toContain('(not an error)')
    } finally {
      spy.mockRestore()
    }
  })

  it('drops the failure when on_error itself throws', () => {
    const logger = filesystem_logger({
      output_path: work_dir,
      on_error: () => {
        throw new Error('reporter down')
      },
    })
    expect(() => logger.record({ kind: 'emit', text: 'lost' })).not.toThrow()
  })

  it('lets a run finish when an emitted value cannot be written', async () => {
    const errors: unknown[] = []
    const logger = filesystem_logger({
      output_path: join(work_dir, 'trajectory.jsonl'),
      on_error: (err) => errors.push(err),
    })
    const flow = step('emit_bigint', (n: number, ctx) => {
      ctx.emit({ count: 1n })
      return n + 1
    })

    await expect(run(flow, 1, { trajectory: logger, install_signal_handlers: false })).resolves.toBe(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(TypeError)
  })
})
