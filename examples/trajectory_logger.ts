/**
 * trajectory_logger: observe a run via filesystem_logger plus a custom sink.
 *
 * Two loggers are wired into the same run: the packaged `filesystem_logger`
 * writes one JSON object per line to a file, and an in-memory `TrajectoryLogger`
 * captures events so the harness can assert on them. Composing loggers is a
 * matter of forwarding each call to both sinks — the `TrajectoryLogger` type
 * is a plain object.
 *
 * Deterministic stub — no engine layer, no network, no LLM calls.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run, sequence, step, type TrajectoryLogger } from '@repo/fascicle'
import { filesystem_logger } from '@repo/fascicle/adapters'

const double = step('double', (n: number): number => n * 2)
const increment = step('increment', (n: number): number => n + 1)

const flow = sequence([double, increment])

function tee(...sinks: readonly TrajectoryLogger[]): TrajectoryLogger {
  return {
    record: (event) => {
      for (const sink of sinks) sink.record(event)
    },
    start_span: (name, meta) => {
      const ids = sinks.map((sink) => sink.start_span(name, meta))
      return ids[0] ?? name
    },
    end_span: (id, meta) => {
      for (const sink of sinks) sink.end_span(id, meta)
    },
  }
}

export async function run_trajectory_logger(): Promise<{
  readonly result: number
  readonly span_names: readonly string[]
  readonly jsonl_line_count: number
}> {
  const root_dir = await mkdtemp(join(tmpdir(), 'fascicle-trajectory-'))
  const output_path = join(root_dir, 'trajectory.jsonl')
  const file_sink = filesystem_logger({ output_path })

  const span_names: string[] = []
  const memory_sink: TrajectoryLogger = {
    record: () => {},
    start_span: (name) => {
      span_names.push(name)
      return `${name}:mem`
    },
    end_span: () => {},
  }

  try {
    const result = await run(flow, 5, {
      install_signal_handlers: false,
      trajectory: tee(file_sink, memory_sink),
    })
    const written = await readFile(output_path, 'utf8')
    const jsonl_line_count = written.split('\n').filter((line) => line.length > 0).length
    return { result, span_names, jsonl_line_count }
  } finally {
    await rm(root_dir, { recursive: true, force: true })
  }
}
