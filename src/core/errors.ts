/**
 * Typed errors for the composition layer.
 *
 * This is the only source file in the core layer that uses the `class`
 * keyword. `Error` is a built-in and `instanceof` branching is how composers
 * like `retry` and `fallback` distinguish failure modes.
 *
 * Every class declares an optional `path`: the chain of step ids the error
 * crossed while bubbling through dispatch. The runner attaches it via
 * Reflect.set (`prepend_path` in runner.ts), so the `declare` modifier types
 * what arrives without emitting a field; construction never sets it.
 */

import type { SchemaIssue } from '#schema'

export class timeout_error extends Error {
  readonly kind = 'timeout_error' as const;
  declare readonly path?: ReadonlyArray<string>;
  readonly timeout_ms: number;
  constructor(message: string, timeout_ms: number) {
    super(message)
    this.name = 'timeout_error'
    this.timeout_ms = timeout_ms
  }
}

export class suspended_error extends Error {
  readonly kind = 'suspended_error' as const;
  declare readonly path?: ReadonlyArray<string>;
  readonly suspend_id: string;
  readonly payload: unknown;
  constructor(suspend_id: string, payload: unknown, message?: string) {
    super(message ?? `suspended at ${suspend_id}`)
    this.name = 'suspended_error'
    this.suspend_id = suspend_id
    this.payload = payload
  }
}

export class resume_validation_error extends Error {
  readonly kind = 'resume_validation_error' as const;
  declare readonly path?: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<SchemaIssue>;
  constructor(message: string, issues: ReadonlyArray<SchemaIssue>) {
    super(message)
    this.name = 'resume_validation_error'
    this.issues = issues
  }
}

export class describe_cycle_error extends Error {
  readonly kind = 'describe_cycle_error' as const;
  declare readonly path?: ReadonlyArray<string>;
  readonly step_id: string;
  constructor(step_id: string, message?: string) {
    super(message ?? `describe: cycle detected at step id: ${step_id}`)
    this.name = 'describe_cycle_error'
    this.step_id = step_id
  }
}

export class aborted_error extends Error {
  readonly kind = 'aborted_error' as const;
  declare readonly path?: ReadonlyArray<string>;
  readonly reason?: unknown;
  // An engine tool-loop position, meaningful only when the abort interrupted a
  // model turn. Core-origin aborts (signals, caller AbortSignals) leave it
  // undefined rather than fabricating index 0.
  readonly step_index?: number;
  readonly tool_call_in_flight?: { id: string; name: string };
  constructor(
    message = 'aborted',
    metadata: {
      reason?: unknown
      step_index?: number
      tool_call_in_flight?: { id: string; name: string }
    } = {},
  ) {
    super(message)
    this.name = 'aborted_error'
    if (metadata.reason !== undefined) this.reason = metadata.reason
    if (metadata.step_index !== undefined) this.step_index = metadata.step_index
    if (metadata.tool_call_in_flight !== undefined) {
      this.tool_call_in_flight = metadata.tool_call_in_flight
    }
  }
}

/**
 * Control-flow signals are not application failures. `suspended_error` is a
 * human-approval gate pausing the run for later resume; `aborted_error` is
 * cancellation. Resilience composers (`retry`, `fallback`) must rethrow these
 * rather than retry past a suspend or run a backup under an aborted context.
 *
 * Kept internal to core: not re-exported by index.ts, so it does not
 * widen the public surface.
 */
export function is_control_flow_error(
  err: unknown,
): err is suspended_error | aborted_error {
  return err instanceof suspended_error || err instanceof aborted_error
}

/**
 * Read the step-id path off any error that crossed the runner's dispatch.
 *
 * The runner attaches `path` to whatever escapes a step, including
 * user-thrown errors the declared class fields cannot type, so a catch block
 * needs a narrowing read rather than a cast. Returns the ids only when the
 * property is present and well-formed (an all-string array); anything else,
 * including non-object inputs, is `undefined`.
 */
export function error_path(err: unknown): ReadonlyArray<string> | undefined {
  if (err === null || typeof err !== 'object') return undefined
  const path: unknown = Reflect.get(err, 'path')
  if (!Array.isArray(path)) return undefined
  const entries: ReadonlyArray<unknown> = path
  const ids = entries.filter((v): v is string => typeof v === 'string')
  return ids.length === entries.length ? ids : undefined
}
