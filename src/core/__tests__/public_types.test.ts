/**
 * Public type surface: every name a core signature mentions must be
 * importable from the umbrella, and the StepInput/StepOutput extractors must
 * resolve to the exact leaf types. Runtime coverage for the value exports
 * this surface added (`is_step`, `error_path`) lives here too, next to the
 * types they narrow.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  branch,
  checkpoint,
  error_path,
  fallback,
  is_step,
  map,
  parallel,
  pipe,
  retry,
  run,
  scope,
  sequence,
  stash,
  step,
  suspend,
  timeout,
  timeout_error,
  use,
} from 'fascicle'
import type {
  AnySchema,
  AnyStep,
  BranchConfig,
  CheckpointConfig,
  CleanupFn,
  FallbackOptions,
  MapConfig,
  ParallelOptions,
  PipeOptions,
  RetryConfig,
  RunOptions,
  SchemaIssue,
  ScopeOptions,
  SequenceOptions,
  StashOptions,
  StepFn,
  StepInput,
  StepOutput,
  StreamingRunHandle,
  SuspendConfig,
  TimeoutOptions,
  ToolSchema,
  UseOptions,
} from 'fascicle'

const run_options: RunOptions = { install_signal_handlers: false }

const double = step('double', (n: number) => n * 2)

const inc: StepFn<number, number> = (n) => n + 1

const noop_cleanup: CleanupFn = () => {}

describe('exported utility types', () => {
  it('StepInput/StepOutput extract the leaf types of a concrete step', () => {
    const input: StepInput<typeof double> = 3
    const output: StepOutput<typeof double> = 6
    // @ts-expect-error StepInput<typeof double> is number, not string
    const wrong_input: StepInput<typeof double> = 'three'
    expect(input).toBe(3)
    expect(output).toBe(6)
    expect(wrong_input).toBe('three')
  })

  it('StepInput/StepOutput degrade to the safe extremes on erased steps', () => {
    const erased_output: StepOutput<AnyStep> = 'anything goes'
    // @ts-expect-error StepInput<AnyStep> is never
    const erased_input: StepInput<AnyStep> = 1
    const non_step_output: StepOutput<number> = 'still unknown'
    // @ts-expect-error StepInput<number> is never, so a non-step cannot slip through
    const non_step_input: StepInput<number> = 1
    expect(erased_output).toBe('anything goes')
    expect(erased_input).toBe(1)
    expect(non_step_output).toBe('still unknown')
    expect(non_step_input).toBe(1)
  })

  it('StepFn and CleanupFn name the function contracts', async () => {
    const result = await run(step('inc', inc), 1, run_options)
    expect(result).toBe(2)
    expect(noop_cleanup()).toBeUndefined()
  })
})

describe('exported composer config and option types', () => {
  it('constructs every composer through its named config type', async () => {
    const sequence_options: SequenceOptions = { name: 'seq' }
    const parallel_options: ParallelOptions = { name: 'par' }
    const pipe_options: PipeOptions = { name: 'shape' }
    const retry_config: RetryConfig = { max_attempts: 1 }
    const fallback_options: FallbackOptions<number> = { handoff: (input) => input }
    const timeout_options: TimeoutOptions = { name: 'bounded' }
    const checkpoint_config: CheckpointConfig<number> = { key: (n) => `n_${n}` }
    const branch_config: BranchConfig<number, number> = {
      when: (n) => n > 0,
      then: double,
      otherwise: double,
    }
    const map_config: MapConfig<ReadonlyArray<number>, number, number> = {
      items: (xs) => xs,
      do: double,
    }
    const scope_options: ScopeOptions = { name: 'scoped' }
    const stash_options: StashOptions = { name: 'stashed' }
    const use_options: UseOptions = { name: 'used' }

    const flow = sequence(
      [
        retry(
          timeout(fallback(double, double, fallback_options), 1_000, timeout_options),
          retry_config,
        ),
        pipe(double, (n) => n, pipe_options),
      ],
      sequence_options,
    )
    expect(await run(flow, 1, run_options)).toBe(4)

    expect(parallel({ a: double }, parallel_options).kind).toBe('parallel')
    expect(branch(branch_config).kind).toBe('branch')
    expect(map(map_config).kind).toBe('map')
    expect(checkpoint(double, checkpoint_config).kind).toBe('checkpoint')
    const scoped = scope(
      [
        stash('doubled', double, stash_options),
        use(['doubled'], (state) => state.doubled, use_options),
      ],
      scope_options,
    )
    expect(scoped.kind).toBe('scope')
  })

  it('SuspendConfig and the schema vocabulary are nameable together', async () => {
    const approve_schema: AnySchema<{ approved: boolean }> = z.object({ approved: z.boolean() })
    const suspend_config: SuspendConfig<string, string, { approved: boolean }> = {
      id: 'approval_gate',
      on: () => {},
      resume_schema: approve_schema,
      combine: (input, resume) => (resume.approved ? input : 'rejected'),
    }
    const outcome = await run(suspend(suspend_config), 'ship it', {
      ...run_options,
      resume_data: { approval_gate: { approved: true } },
    })
    expect(outcome).toBe('ship it')

    const issue: SchemaIssue = { message: 'bad', path: ['field'] }
    expect(issue.message).toBe('bad')
    // Compile-time: every ToolSchema is an AnySchema; the narrowing is one-way.
    const widens: ToolSchema extends AnySchema ? true : false = true
    expect(widens).toBe(true)
  })

  it('RunOptions and StreamingRunHandle type the run entry points', async () => {
    const handle: StreamingRunHandle<number> = run.stream(double, 21, run_options)
    const kinds: string[] = []
    for await (const event of handle.events) {
      kinds.push(event.kind)
    }
    expect(await handle.result).toBe(42)
    expect(kinds.at(-1)).toBe('run_end')
  })
})

describe('is_step umbrella export', () => {
  it('detects steps structurally and rejects near-misses', () => {
    expect(is_step(double)).toBe(true)
    expect(is_step({ id: 'x', kind: 'step' })).toBe(false)
    expect(is_step(null)).toBe(false)
    expect(is_step(() => {})).toBe(false)
  })
})

describe('error_path', () => {
  it('reads the path the runner attached to a fascicle error', async () => {
    const flow = sequence([
      step('pre', (n: number) => n),
      step('boom', (): number => {
        throw new timeout_error('too slow', 5)
      }),
    ])
    let caught: unknown = undefined
    try {
      await run(flow, 1, run_options)
    } catch (err) {
      caught = err
    }
    const path = error_path(caught)
    expect(path).toBeDefined()
    expect(path).toContain('boom')
    if (!(caught instanceof timeout_error)) throw new Error('expected a timeout_error')
    // The declared field and the helper read the same attachment, no cast.
    const declared: ReadonlyArray<string> | undefined = caught.path
    expect(declared).toEqual(path)
  })

  it('reads the path attached to a foreign user-thrown error', async () => {
    const flow = sequence([
      step('user_boom', (): number => {
        throw new Error('nope')
      }),
    ])
    let caught: unknown = undefined
    try {
      await run(flow, 0, run_options)
    } catch (err) {
      caught = err
    }
    expect(error_path(caught)).toContain('user_boom')
  })

  it('returns undefined when the error carries no path', () => {
    expect(error_path(new Error('bare'))).toBeUndefined()
  })

  it('returns undefined for non-error input', () => {
    expect(error_path(null)).toBeUndefined()
    expect(error_path(undefined)).toBeUndefined()
    expect(error_path('a string')).toBeUndefined()
    expect(error_path(42)).toBeUndefined()
  })

  it('rejects a malformed path instead of guessing', () => {
    const not_array = new Error('shaped wrong')
    Reflect.set(not_array, 'path', 'not-an-array')
    expect(error_path(not_array)).toBeUndefined()

    const mixed = new Error('mixed entries')
    Reflect.set(mixed, 'path', ['ok', 42])
    expect(error_path(mixed)).toBeUndefined()
  })

  it('returns the full id list for a well-formed foreign carrier', () => {
    const carrier = { path: ['sequence_9000', 'leaf'] }
    expect(error_path(carrier)).toEqual(['sequence_9000', 'leaf'])
  })

  it('fresh error instances declare path without emitting a field', () => {
    const err = new timeout_error('x', 1)
    expect(err.path).toBeUndefined()
    expect(Object.hasOwn(err, 'path')).toBe(false)
  })
})
