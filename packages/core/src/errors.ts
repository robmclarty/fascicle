/**
 * Typed errors for the composition layer.
 *
 * This is the only source file in packages/core/src/ that uses the `class`
 * keyword. `Error` is a built-in and `instanceof` branching is how composers
 * like `retry` and `fallback` distinguish failure modes. See constraints.md §2.
 */

export class timeout_error extends Error {
  readonly kind = 'timeout_error' as const;
  readonly timeout_ms: number;
  constructor(message: string, timeout_ms: number) {
    super(message);
    this.name = 'timeout_error';
    this.timeout_ms = timeout_ms;
  }
}

export class suspended_error extends Error {
  readonly kind = 'suspended_error' as const;
  readonly suspend_id: string;
  readonly payload: unknown;
  constructor(suspend_id: string, payload: unknown, message?: string) {
    super(message ?? `suspended at ${suspend_id}`);
    this.name = 'suspended_error';
    this.suspend_id = suspend_id;
    this.payload = payload;
  }
}

export class resume_validation_error extends Error {
  readonly kind = 'resume_validation_error' as const;
  readonly issues: unknown;
  constructor(message: string, issues: unknown) {
    super(message);
    this.name = 'resume_validation_error';
    this.issues = issues;
  }
}

export class describe_cycle_error extends Error {
  readonly kind = 'describe_cycle_error' as const;
  readonly step_id: string;
  constructor(step_id: string, message?: string) {
    super(message ?? `describe: cycle detected at step id: ${step_id}`);
    this.name = 'describe_cycle_error';
    this.step_id = step_id;
  }
}

export class aborted_error extends Error {
  readonly kind = 'aborted_error' as const;
  readonly reason?: unknown;
  readonly step_index: number;
  readonly tool_call_in_flight?: { id: string; name: string };
  constructor(
    message = 'aborted',
    metadata: {
      reason?: unknown;
      step_index?: number;
      tool_call_in_flight?: { id: string; name: string };
    } = {},
  ) {
    super(message);
    this.name = 'aborted_error';
    if (metadata.reason !== undefined) this.reason = metadata.reason;
    this.step_index = metadata.step_index ?? 0;
    if (metadata.tool_call_in_flight !== undefined) {
      this.tool_call_in_flight = metadata.tool_call_in_flight;
    }
  }
}
