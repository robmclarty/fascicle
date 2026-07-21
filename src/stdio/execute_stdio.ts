/**
 * The stdio agent contract, minus the process.
 *
 * `execute_stdio` is everything `run_stdio` does (read, parse, validate, run,
 * validate, serialize, dispose), expressed over an injected `StdioIo` and
 * returning a `StdioOutcome` instead of touching `process.*` or exiting. The
 * split keeps the contract's branching unit-testable; the thin glue in
 * `run_stdio.ts` owns the real streams and the exit.
 *
 * The governing invariant: code 0 if and only if stdout carries an
 * authoritative result. That is why the engine is disposed before the output
 * is written (a teardown failure on the success path yields code 1 and no
 * stdout) and why every failure class short-circuits before `write_output`.
 * Code 1 means the flow did not produce a result (including a forwarded
 * SIGINT/SIGTERM aborting the run, or a failed delivery); code 2 means the
 * contract itself was violated (unparseable stdin, schema mismatch in either
 * direction, unserializable result).
 */

import type { z } from 'zod'
import { run } from '#core'
import type { Step, TrajectoryLogger } from '#core'
import { stderr_logger } from '#adapters'

export type RunStdioOptions<i, o> = {
  readonly input_schema?: z.ZodType<i>
  readonly output_schema?: z.ZodType<o>
  // Structural on purpose: anything with an async dispose qualifies, and the
  // stdio module never imports the engine layer.
  readonly engine?: { readonly dispose: () => Promise<void> }
  readonly trajectory?: TrajectoryLogger
  readonly abort?: AbortSignal
}

export type StdioFailure = {
  readonly error: string
  readonly stage?:
    | 'read'
    | 'parse'
    | 'validate_input'
    | 'run'
    | 'validate_output'
    | 'serialize'
    | 'write'
    | 'dispose'
  readonly cause?: unknown
}

export type StdioOutcome =
  | { readonly code: 0 }
  | { readonly code: 1 | 2; readonly failure: StdioFailure }

export type StdioIo = {
  readonly read_input: () => Promise<string>
  // Resolves once the bytes are flushed to the OS, so the caller may exit.
  readonly write_output: (text: string) => Promise<void>
  readonly error_stream: { write(chunk: string): unknown }
}

/**
 * Runs the stdio agent contract over injected `io`: read input, run the
 * flow, dispose the engine, write output, and return the outcome as a
 * value.
 *
 * Disposes the engine before writing output so a teardown failure on the
 * success path yields code 1 and no stdout, keeping "code 0 means stdout
 * carries an authoritative result" true even when disposal fails.
 */
export async function execute_stdio<i, o>(
  flow: Step<i, o>,
  options: RunStdioOptions<i, o>,
  io: StdioIo,
): Promise<StdioOutcome> {
  const produced = await produce_output(flow, options, io)
  const dispose_failure = await dispose_engine(options.engine)
  if (produced.kind === 'failed') return { code: produced.code, failure: produced.failure }
  if (dispose_failure !== null) return { code: 1, failure: dispose_failure }
  try {
    await io.write_output(`${produced.json}\n`)
  } catch (err) {
    return { code: 1, failure: make_failure('write', err) }
  }
  return { code: 0 }
}

type ProduceResult =
  | { readonly kind: 'ok'; readonly json: string }
  | { readonly kind: 'failed'; readonly code: 1 | 2; readonly failure: StdioFailure }

/**
 * Reads stdin, parses and validates it against the input schema, runs the
 * flow, then validates and serializes the result.
 *
 * Returns a tagged result instead of throwing so `execute_stdio` can dispose
 * the engine and choose the right exit code regardless of which stage
 * failed.
 */
async function produce_output<i, o>(
  flow: Step<i, o>,
  options: RunStdioOptions<i, o>,
  io: StdioIo,
): Promise<ProduceResult> {
  let raw: string
  try {
    raw = await io.read_input()
  } catch (err) {
    return { kind: 'failed', code: 2, failure: make_failure('read', err) }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { kind: 'failed', code: 2, failure: make_failure('parse', err) }
  }

  let input: i
  if (options.input_schema !== undefined) {
    const checked = options.input_schema.safeParse(parsed)
    if (!checked.success) {
      return {
        kind: 'failed',
        code: 2,
        failure: {
          error: 'input failed schema validation',
          stage: 'validate_input',
          cause: to_json_safe(checked.error.issues),
        },
      }
    }
    input = checked.data
  } else {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    input = parsed as i
  }

  const trajectory = options.trajectory ?? stderr_logger({ stream: io.error_stream })

  let result: o
  try {
    result = await run(flow, input, {
      trajectory,
      ...(options.abort !== undefined ? { abort: options.abort } : {}),
    })
  } catch (err) {
    return { kind: 'failed', code: 1, failure: make_failure('run', err) }
  }

  let output: unknown = result
  if (options.output_schema !== undefined) {
    const checked = options.output_schema.safeParse(result)
    if (!checked.success) {
      return {
        kind: 'failed',
        code: 2,
        failure: {
          error: 'flow result failed schema validation',
          stage: 'validate_output',
          cause: to_json_safe(checked.error.issues),
        },
      }
    }
    output = checked.data
  }

  let json: string | undefined
  try {
    json = JSON.stringify(output)
  } catch (err) {
    return { kind: 'failed', code: 2, failure: make_failure('serialize', err) }
  }
  if (json === undefined) {
    return {
      kind: 'failed',
      code: 2,
      failure: { error: 'flow result is not JSON-serializable', stage: 'serialize' },
    }
  }
  return { kind: 'ok', json }
}

/**
 * Disposes the caller's engine when one was supplied, returning a
 * `StdioFailure` if disposal throws and `null` otherwise.
 */
async function dispose_engine(
  engine: RunStdioOptions<never, never>['engine'],
): Promise<StdioFailure | null> {
  if (engine === undefined) return null
  try {
    await engine.dispose()
    return null
  } catch (err) {
    return make_failure('dispose', err)
  }
}

/**
 * Builds a `StdioFailure` for the given stage from a thrown value.
 */
function make_failure(stage: NonNullable<StdioFailure['stage']>, err: unknown): StdioFailure {
  const cause = safe_cause(err)
  return {
    error: err instanceof Error ? err.message : String(err),
    stage,
    ...(cause !== undefined ? { cause } : {}),
  }
}

/**
 * Reduces a thrown value to a JSON-safe cause for `StdioFailure`.
 *
 * An `Error` is reduced to its `name`, `message`, and Zod's `path` property
 * when present (`safeParse` issues carry one); anything else is passed
 * through `to_json_safe`.
 */
function safe_cause(err: unknown): unknown {
  if (err instanceof Error) {
    const path = Reflect.get(err, 'path')
    return {
      name: err.name,
      message: err.message,
      ...(Array.isArray(path) ? { path: to_json_safe(path) } : {}),
    }
  }
  return to_json_safe(err)
}

/**
 * Round-trips a value through `JSON.stringify`/`parse` so it is safe to
 * embed in a `StdioFailure` that the glue will serialize again.
 *
 * Never throws and never returns a value that would make that later
 * serialization throw or silently vanish: a circular reference or a BigInt
 * becomes `undefined` instead.
 */
function to_json_safe(value: unknown): unknown {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return undefined
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}
