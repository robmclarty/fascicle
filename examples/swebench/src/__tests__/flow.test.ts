/**
 * Flow tests through the real `run()` with a capture engine and the noop
 * sandbox. They pin the two things the per-case step is responsible for: the
 * provider-dependent tool surface, and the Prediction it hands back to bench.
 */

import { run } from 'fascicle'
import { make_capture_engine } from 'fascicle/testing'
import { describe, expect, it } from 'vitest'

import { solve_instance } from '../flow.js'
import { noop_sandbox } from '../sandbox.js'
import type { SweBenchInstance } from '../types.js'

const INSTANCE: SweBenchInstance = {
  instance_id: 'example__example-0000',
  repo: 'example/example',
  base_commit: 'deadbeef',
  problem_statement: 'the widget explodes when the input is empty',
  hints_text: '',
  test_patch: '',
  version: '1.0',
  fail_to_pass: ['tests/test_widget.py::test_empty'],
  pass_to_pass: ['tests/test_widget.py::test_basic'],
}

describe('solve_instance', () => {
  it('injects the sandbox tool surface under an API provider', async () => {
    const { engine, calls } = make_capture_engine()
    await run(
      solve_instance({
        provider: 'anthropic',
        engine,
        model: 'claude-sonnet-4-6',
        sandbox_factory: noop_sandbox,
        model_name_or_path: 'test',
      }),
      INSTANCE,
      { install_signal_handlers: false },
    )
    expect(calls).toHaveLength(1)
    expect((calls[0]?.tools ?? []).map((t) => t.name)).toEqual([
      'read_file',
      'write_file',
      'run_command',
      'list_files',
      'grep_files',
    ])
  })

  it('sends the solver role id as the first line of the system prompt', async () => {
    const { engine, calls } = make_capture_engine()
    await run(
      solve_instance({
        provider: 'anthropic',
        engine,
        model: 'claude-sonnet-4-6',
        sandbox_factory: noop_sandbox,
        model_name_or_path: 'test',
      }),
      INSTANCE,
      { install_signal_handlers: false },
    )
    expect(calls[0]?.system?.split('\n')[0]).toBe('swebench/solver')
  })

  it('returns a Prediction in the shape the eval harness consumes', async () => {
    const { engine } = make_capture_engine()
    const prediction = await run(
      solve_instance({
        provider: 'anthropic',
        engine,
        model: 'claude-sonnet-4-6',
        sandbox_factory: noop_sandbox,
        model_name_or_path: 'fascicle-test',
      }),
      INSTANCE,
      { install_signal_handlers: false },
    )
    expect(prediction.instance_id).toBe(INSTANCE.instance_id)
    expect(prediction.model_name_or_path).toBe('fascicle-test')
    expect(typeof prediction.model_patch).toBe('string')
  })
})
