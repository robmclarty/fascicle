/**
 * End-to-end wiring tests across core + observability + stores.
 *
 * These exercise the public value contracts that cross package boundaries
 * (spec.md §6): the filesystem trajectory logger, the filesystem checkpoint
 * store, and `run` / `run.stream` equivalence on identical inputs.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filesystem_logger } from '@repo/observability'
import { filesystem_store } from '@repo/stores'
import { checkpoint } from '../../src/checkpoint.js'
import { run } from '../../src/runner.js'
import { sequence } from '../../src/sequence.js'
import { step } from '../../src/step.js'
import type { TrajectoryEvent } from '../../src/types.js'

let work_dir: string

beforeEach(async () => {
  work_dir = await mkdtemp(join(tmpdir(), 'fascicle-integration-'))
})

afterEach(async () => {
  await rm(work_dir, { recursive: true, force: true })
})

async function read_jsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
}

function normalize_events(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return events.map((e) => {
    const { span_id: _span_id, parent_span_id: _parent, run_id: _run_id, ...rest } = e
    void _span_id
    void _parent
    void _run_id
    return rest
  })
}

describe('core + stores: checkpoint persistence across runs', () => {
  it('skips inner on second run and returns identical output', async () => {
    const store = filesystem_store({ root_dir: join(work_dir, 'ckpt') })
    let inner_calls = 0
    const expensive = step('expensive', (n: number) => {
      inner_calls += 1
      return n * 2
    })
    const flow = checkpoint(expensive, { key: 'fixed-key' })
  
    const first = await run(flow, 21, {
      install_signal_handlers: false,
      checkpoint_store: store,
    })
    const second = await run(flow, 21, {
      install_signal_handlers: false,
      checkpoint_store: store,
    })
  
    expect(first).toBe(42)
    expect(second).toBe(42)
    expect(inner_calls).toBe(1)
  })

  it('treats a corrupt file on disk as a cache miss and runs inner fresh', async () => {
    const root = join(work_dir, 'ckpt')
    const store = filesystem_store({ root_dir: root })
    const expensive = step('expensive', (n: number) => n + 100)
    const flow = checkpoint(expensive, { key: 'corrupt-key' })
  
    const first = await run(flow, 7, {
      install_signal_handlers: false,
      checkpoint_store: store,
    })
    expect(first).toBe(107)
  
    const stored = await store.get('corrupt-key')
    expect(stored).toBe(107)
  
    const entries = await (await import('node:fs/promises')).readdir(root)
    const target = entries.find((name) => name.startsWith('corrupt-key.'))
    expect(target).toBeDefined()
    if (target === undefined) throw new Error('unreachable')
    await writeFile(join(root, target), '{ not valid json', 'utf8')
  
    const miss = await store.get('corrupt-key')
    expect(miss).toBeNull()
  
    let reran = false
    const flow_b = checkpoint(
      step('expensive', (n: number) => {
        reran = true
        return n + 100
      }),
      { key: 'corrupt-key' },
    )
    const second = await run(flow_b, 7, {
      install_signal_handlers: false,
      checkpoint_store: store,
    })
    expect(second).toBe(107)
    expect(reran).toBe(true)
  })
})

describe('core + observability: trajectory hierarchy', () => {
  it('records span_start / span_end pairs with parent linkage for nested steps', async () => {
    const log_path = join(work_dir, 'trajectory.jsonl')
    const trajectory = filesystem_logger({ output_path: log_path })
  
    const flow = sequence([
      step('alpha', (n: number) => n + 1),
      step('beta', (n: number) => n * 10),
    ])
  
    const result = await run(flow, 2, { install_signal_handlers: false, trajectory })
    expect(result).toBe(30)
  
    const events = await read_jsonl(log_path)
    const kinds = events.map((e) => e['kind'] as string)
    expect(kinds).toContain('span_start')
    expect(kinds).toContain('span_end')
  
    const sequence_start = events.find(
      (e) => e['kind'] === 'span_start' && e['name'] === 'sequence',
    )
    expect(sequence_start).toBeDefined()
    if (sequence_start === undefined) throw new Error('unreachable')
    expect(sequence_start['parent_span_id']).toBeUndefined()
    const sequence_span_id = sequence_start['span_id'] as string
  
    const step_starts = events.filter(
      (e) => e['kind'] === 'span_start' && e['name'] === 'step',
    )
    expect(step_starts.length).toBe(2)
    for (const event of step_starts) {
      expect(event['parent_span_id']).toBe(sequence_span_id)
    }
  
    for (const start of step_starts) {
      const matching_end = events.find(
        (e) => e['kind'] === 'span_end' && e['span_id'] === start['span_id'],
      )
      expect(matching_end).toBeDefined()
    }
  
    const sequence_end = events.find(
      (e) => e['kind'] === 'span_end' && e['span_id'] === sequence_span_id,
    )
    expect(sequence_end).toBeDefined()
  })
})

describe('core: run vs run.stream equivalence', () => {
  it('produces identical final result and identical trajectory content', async () => {
    const log_a = join(work_dir, 'run.jsonl')
    const log_b = join(work_dir, 'stream.jsonl')
    const flow = sequence([
      step('alpha', (n: number) => n + 1),
      step('beta', (n: number) => n * 3),
    ])
  
    const result_a = await run(flow, 4, {
      install_signal_handlers: false,
      trajectory: filesystem_logger({ output_path: log_a }),
    })
  
    const handle = run.stream(flow, 4, {
      install_signal_handlers: false,
      trajectory: filesystem_logger({ output_path: log_b }),
    })
  
    const streamed_events: TrajectoryEvent[] = []
    for await (const event of handle.events) streamed_events.push(event)
    const result_b = await handle.result
  
    expect(result_b).toBe(result_a)
  
    const disk_a = await read_jsonl(log_a)
    const disk_b = await read_jsonl(log_b)
  
    expect(normalize_events(disk_b)).toEqual(normalize_events(disk_a))
    expect(streamed_events.length).toBeGreaterThan(0)
  })
})
