/**
 * Cross-layer integration (spec §12 #26, §10 criterion 9).
 *
 * Exercises the full stack: @repo/core.run → step → engine.generate →
 * claude_cli adapter → mock binary. Proves:
 *   (a) cli-sonnet alias resolves to the claude_cli subprocess adapter;
 *   (b) content from the mock arrives at the step's return value;
 *   (c) trajectory records engine-emitted cost with source 'provider_reported';
 *   (d) ctx.abort threaded into engine.generate cancels the in-flight call;
 *   (e) a real SIGINT propagates from the node process → core runner →
 *       engine → claude_cli adapter → mock subprocess (subprocess harness).
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { run, step } from '@repo/core'
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core'
import { create_engine } from '../../../src/create_engine.js'
import { aborted_error } from '../../../src/errors.js'
import {
  MOCK_CLAUDE_PATH,
  build_mock_env,
  create_captured_trajectory,
  success_ops,
  write_mock_script,
  type MockScriptHandle,
} from './fixtures/mock_helpers.js'

const here = dirname(fileURLToPath(import.meta.url))

const cleanup_stack: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup_stack.length > 0) {
    const fn = cleanup_stack.pop()
    if (fn !== undefined) await fn()
  }
})

async function track(handle: MockScriptHandle): Promise<MockScriptHandle> {
  cleanup_stack.push(handle.cleanup)
  return handle
}

function build_capture_logger(): {
  logger: TrajectoryLogger
  events: TrajectoryEvent[]
} {
  const events: TrajectoryEvent[] = []
  let counter = 0
  const logger: TrajectoryLogger = {
    record: (e) => events.push(e),
    start_span: () => {
      counter += 1
      return `s${counter}`
    },
    end_span: () => {},
  }
  return { logger, events }
}

describe('cli-sonnet step inside core.run (§12 #26)', () => {
  it('returns content and records provider_reported cost in the trajectory', async () => {
    const handle = await track(
      await write_mock_script(
        success_ops('cross-layer-ok', {
          total_cost_usd: 0.0042,
          input_tokens: 100,
          output_tokens: 25,
        }),
      ),
    )
  
    const engine = create_engine({
      providers: { claude_cli: { binary: MOCK_CLAUDE_PATH, auth_mode: 'oauth' } },
    })
    cleanup_stack.push(() => engine.dispose())
  
    const { logger, events } = build_capture_logger()
  
    const flow = step<string, string>('cli_step', async (input, ctx) => {
      const result = await engine.generate({
        model: 'cli-sonnet',
        prompt: input,
        abort: ctx.abort,
        trajectory: ctx.trajectory,
        provider_options: {
          claude_cli: {
            env: {
              PATH: process.env['PATH'] ?? '',
              MOCK_CLAUDE_SCRIPT: handle.script_path,
            },
          },
        },
      })
      return result.content
    })
  
    const out = await run(flow, 'hello', { trajectory: logger })
    expect(out).toBe('cross-layer-ok')
  
    const cost_events = events.filter((e) => e.kind === 'cost')
    expect(cost_events.length).toBeGreaterThan(0)
    const first = cost_events[0] as {
      kind: string
      source: string
      total_usd: number
    }
    expect(first.source).toBe('provider_reported')
    expect(first.total_usd).toBeCloseTo(0.0042, 9)
  })
})

describe('cli-sonnet Message[] prompt extraction', () => {
  it('extracts text from system + user-with-content-parts prompts', async () => {
    const handle = await track(
      await write_mock_script(success_ops('msgs-ok', { session_id: 's-msg' })),
    )
  
    const engine = create_engine({
      providers: { claude_cli: { binary: MOCK_CLAUDE_PATH, auth_mode: 'oauth' } },
    })
    cleanup_stack.push(() => engine.dispose())
  
    const result = await engine.generate({
      model: 'cli-sonnet',
      prompt: [
        { role: 'system', content: 'you are terse' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'part one' },
            { type: 'text', text: 'part two' },
          ],
        },
      ],
      provider_options: {
        claude_cli: {
          env: build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path }),
        },
      },
    })
  
    expect(result.content).toBe('msgs-ok')
  })
})

describe('cli-sonnet trajectory span tree under abort (criterion 7)', () => {
  it(
    'on abort, trajectory contains engine.generate span ended with { error } and at least one engine.generate.step child span',
    async () => {
      const handle = await track(
        await write_mock_script([
          {
            op: 'line',
            data: { type: 'system', subtype: 'init', session_id: 's', model: 'm' },
          },
          {
            op: 'line',
            data: {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'partial' }] },
            },
          },
          { op: 'hang' },
        ]),
      )
  
      const engine = create_engine({
        providers: { claude_cli: { binary: MOCK_CLAUDE_PATH, auth_mode: 'oauth' } },
      })
      cleanup_stack.push(() => engine.dispose())
  
      const traj = create_captured_trajectory()
      const ctrl = new AbortController()
  
      const promise = engine.generate({
        model: 'cli-sonnet',
        prompt: 'hello',
        abort: ctrl.signal,
        trajectory: traj.logger,
        provider_options: {
          claude_cli: {
            env: build_mock_env({ MOCK_CLAUDE_SCRIPT: handle.script_path }),
          },
        },
      })
  
      // Let the child emit init + assistant text so we're mid-stream.
      await new Promise((r) => setTimeout(r, 250))
      ctrl.abort(new Error('test-cancel'))
      await expect(promise).rejects.toThrow(aborted_error)
  
      const gen_span = traj.spans.find((s) => s.name === 'engine.generate')
      expect(gen_span, 'engine.generate span was not opened').toBeDefined()
      expect(gen_span?.ended, 'engine.generate span never ended').toBeDefined()
      expect(gen_span?.ended?.['error']).toBeDefined()
  
      const step_spans = traj.spans.filter((s) => s.name === 'engine.generate.step')
      expect(step_spans.length).toBeGreaterThanOrEqual(1)
    },
    10_000,
  )
})

/* --------------------------------------------------------------------------
 * SIGINT propagation subprocess harness (§10 criterion 9 / §12 #26)
 * ------------------------------------------------------------------------*/

async function wait_for_marker(path: string, timeout_ms: number): Promise<void> {
  const deadline = Date.now() + timeout_ms
  while (Date.now() < deadline) {
    try {
      await stat(path)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  throw new Error(`marker never appeared at ${path}`)
}

describe('SIGINT propagation through core → engine → claude_cli', () => {
  it('SIGINT during a claude_cli generate aborts the run and kills the subprocess', async () => {
    const marker_dir = await mkdtemp(join(tmpdir(), 'fascicle-cli-sigint-'))
    cleanup_stack.push(() => rm(marker_dir, { recursive: true, force: true }))
  
    const mock_script_path = join(marker_dir, 'script.json')
    await writeFile(mock_script_path, JSON.stringify([{ op: 'hang' }]))
  
    const harness = join(here, 'fixtures', 'cli_sigint_harness.ts')
    const register_script = join(here, '..', '..', 'cleanup', 'register-ts-resolver.mjs')
  
    const child = spawn(
      process.execPath,
      ['--import', register_script, harness],
      {
        cwd: here,
        env: {
          ...process.env,
          MARKER_DIR: marker_dir,
          MOCK_CLAUDE_BIN: MOCK_CLAUDE_PATH,
          MOCK_SCRIPT: mock_script_path,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    if (child.pid === undefined) throw new Error('child failed to spawn')
  
    let stderr = ''
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
    })
  
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }))
    })
  
    // Wait until the runner has started and the step has reached the engine call.
    await wait_for_marker(join(marker_dir, 'ready'), 15_000)
    // Slight delay to ensure the subprocess child is spawned.
    await new Promise((r) => setTimeout(r, 200))
  
    process.kill(child.pid, 'SIGINT')
  
    const result = await exit
    expect(
      result.code !== 0 || result.signal !== null,
      `expected non-zero exit. stderr:\n${stderr}`,
    ).toBe(true)
  
    await stat(join(marker_dir, 'cleanup.first.ok'))
    await stat(join(marker_dir, 'cleanup.second.ok'))
  
    const engine_err_raw = await readFile(join(marker_dir, 'engine-error.json'), 'utf8')
    const engine_err = JSON.parse(engine_err_raw) as {
      is_engine_aborted_error: boolean
      name: string
    }
    expect(engine_err.is_engine_aborted_error).toBe(true)
    expect(engine_err.name).toBe('aborted_error')
  }, 30_000)
})
