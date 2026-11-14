/**
 * Typed errors for the A2A adapter.
 *
 * Listed alongside src/acp/errors.ts in the `no-class` rule ignores:
 * `instanceof` branching is how callers tell a missing optional peer apart
 * from a remote task that didn't complete.
 */

export class a2a_sdk_missing_error extends Error {
  readonly kind = 'a2a_sdk_missing_error' as const;
  constructor(
    message = '@a2a-js/sdk is required for fascicle/a2a; install it: pnpm add @a2a-js/sdk',
  ) {
    super(message)
    this.name = 'a2a_sdk_missing_error'
  }
}

/**
 * What an `a2a_error` knows about the task it came from.
 */
export type A2aErrorDetail = {
  /** The task's state as A2A spells it, such as `TASK_STATE_FAILED`. */
  readonly state?: string | undefined
  /** The text of the task's status message, when it had one. */
  readonly status_text?: string | undefined
  readonly task_id?: string | undefined
}

/**
 * A task that came to rest somewhere other than `COMPLETED`, or a call the
 * adapter can't carry out. `state` and `status_text` are set when a remote
 * task ended failed, rejected, canceled, or waiting for credentials.
 */
export class a2a_error extends Error {
  readonly kind = 'a2a_error' as const;
  readonly state: string | undefined;
  readonly status_text: string | undefined;
  readonly task_id: string | undefined;
  constructor(message: string, detail: A2aErrorDetail = {}) {
    super(message)
    this.name = 'a2a_error'
    this.state = detail.state
    this.status_text = detail.status_text
    this.task_id = detail.task_id
  }
}
