/**
 * Typed errors for the AI engine layer.
 *
 * This is the only source file in the engine module permitted to use the
 * `class` keyword. `Error` is a built-in and `instanceof` branching is how
 * the retry helper and composition-layer composers distinguish failure modes.
 * See constraints §2.
 *
 * `aborted_error` is defined in the core module and re-exported here so that
 * `instanceof aborted_error` is true regardless of which layer surfaced it
 * (D5 in NOTES.md). This is the one value-level import from core permitted
 * in engine source — see `rules/no-core-value-import-in-engine.yml` ignores.
 */

export { aborted_error } from '#core'

export class rate_limit_error extends Error {
  readonly kind = 'rate_limit_error' as const;
  readonly retry_after_ms: number | undefined;
  readonly attempts: number;
  readonly status: number | undefined;
  constructor(
    message: string,
    metadata: { retry_after_ms?: number; attempts?: number; status?: number } = {},
  ) {
    super(message)
    this.name = 'rate_limit_error'
    this.retry_after_ms = metadata.retry_after_ms
    this.attempts = metadata.attempts ?? 0
    this.status = metadata.status
  }
}

export class provider_error extends Error {
  readonly kind = 'provider_error' as const;
  readonly status: number | undefined;
  readonly body: string | undefined;
  readonly cause_kind: 'provider_5xx' | 'network' | 'unknown' | undefined;
  constructor(
    message: string,
    metadata: {
      status?: number
      body?: string
      cause_kind?: 'provider_5xx' | 'network' | 'unknown'
    } = {},
  ) {
    super(message)
    this.name = 'provider_error'
    this.status = metadata.status
    this.body = metadata.body
    this.cause_kind = metadata.cause_kind
  }
}

/**
 * Turn-timeout expiry (D5). Thrown by the engine-owned retry_turn wrapper when
 * a depth-1 invoke_turn exceeds `turn_timeout_ms` before any chunk streamed.
 * Its `kind` is the RetryFailureKind wire value `'timeout'` (not the class
 * name) on purpose: that is the discriminant classify_retryable /
 * classify_provider_error already key on, so the shared classifier treats an
 * expiry as retryable without any timeout-specific branch. A mid-stream expiry
 * never reaches here — retry_turn converts it to a non-retryable stream
 * interruption first (C4 parity).
 */
export class turn_timeout_error extends Error {
  readonly kind = 'timeout' as const;
  readonly timeout_ms: number;
  readonly step_index: number | undefined;
  constructor(timeout_ms: number, step_index?: number) {
    super(`turn exceeded turn_timeout_ms budget of ${timeout_ms}ms`)
    this.name = 'turn_timeout_error'
    this.timeout_ms = timeout_ms
    this.step_index = step_index
  }
}

export class schema_validation_error extends Error {
  readonly kind = 'schema_validation_error' as const;
  readonly zod_error: unknown;
  readonly raw_text: string;
  constructor(message: string, zod_error: unknown, raw_text: string) {
    super(message)
    this.name = 'schema_validation_error'
    this.zod_error = zod_error
    this.raw_text = raw_text
  }
}

export class tool_error extends Error {
  readonly kind = 'tool_error' as const;
  readonly tool_name: string;
  readonly tool_call_id: string;
  override readonly cause: unknown;
  constructor(
    message: string,
    metadata: { tool_name: string; tool_call_id: string; cause: unknown },
  ) {
    super(message)
    this.name = 'tool_error'
    this.tool_name = metadata.tool_name
    this.tool_call_id = metadata.tool_call_id
    this.cause = metadata.cause
  }
}

export class tool_approval_denied_error extends Error {
  readonly kind = 'tool_approval_denied_error' as const;
  readonly tool_name: string;
  readonly step_index: number;
  readonly tool_call_id: string;
  constructor(
    message: string,
    metadata: { tool_name: string; step_index: number; tool_call_id: string },
  ) {
    super(message)
    this.name = 'tool_approval_denied_error'
    this.tool_name = metadata.tool_name
    this.step_index = metadata.step_index
    this.tool_call_id = metadata.tool_call_id
  }
}

export class model_required_error extends Error {
  readonly kind = 'model_required_error' as const;
  constructor(
    message = 'no model specified: pass `model` to generate() or set `defaults.model` on the engine',
  ) {
    super(message)
    this.name = 'model_required_error'
  }
}

export class provider_not_configured_error extends Error {
  readonly kind = 'provider_not_configured_error' as const;
  readonly provider: string;
  constructor(provider: string) {
    super(`provider '${provider}' is not configured on this engine`)
    this.name = 'provider_not_configured_error'
    this.provider = provider
  }
}

export class engine_config_error extends Error {
  readonly kind = 'engine_config_error' as const;
  readonly provider: string | undefined;
  constructor(message: string, provider?: string) {
    super(message)
    this.name = 'engine_config_error'
    this.provider = provider
  }
}

export class on_chunk_error extends Error {
  readonly kind = 'on_chunk_error' as const;
  override readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message)
    this.name = 'on_chunk_error'
    this.cause = cause
  }
}

export class provider_capability_error extends Error {
  readonly kind = 'provider_capability_error' as const;
  readonly provider: string;
  readonly capability: string;
  constructor(provider: string, capability: string, detail?: string) {
    const suffix = detail !== undefined ? `: ${detail}` : ''
    super(`provider '${provider}' does not support '${capability}'${suffix}`)
    this.name = 'provider_capability_error'
    this.provider = provider
    this.capability = capability
  }
}

export class engine_disposed_error extends Error {
  readonly kind = 'engine_disposed_error' as const;
  constructor(message = 'engine has been disposed; further calls are not permitted') {
    super(message)
    this.name = 'engine_disposed_error'
  }
}

export type ClaudeCliErrorReason =
  | 'binary_not_found'
  | 'auth_missing'
  | 'auth_expired'
  | 'api_key_missing'
  | 'startup_timeout'
  | 'stall_timeout'
  | 'no_result_event'
  | 'result_error'
  | 'subprocess_exit'
  | 'sandbox_unavailable'
  | 'engine_disposed'
  | 'parse_error'

export class claude_cli_error extends Error {
  readonly kind = 'claude_cli_error' as const;
  readonly reason: ClaudeCliErrorReason;
  readonly status: number | undefined;
  readonly stderr_snippet: string | undefined;
  constructor(
    reason: ClaudeCliErrorReason,
    message: string,
    metadata: { status?: number; stderr_snippet?: string } = {},
  ) {
    super(message)
    this.name = 'claude_cli_error'
    this.reason = reason
    this.status = metadata.status
    this.stderr_snippet = metadata.stderr_snippet
  }
}

export class provider_auth_error extends Error {
  readonly kind = 'provider_auth_error' as const;
  readonly provider: string;
  readonly refresh_command: string | undefined;
  constructor(
    provider: string,
    message: string,
    metadata: { refresh_command?: string } = {},
  ) {
    super(message)
    this.name = 'provider_auth_error'
    this.provider = provider
    this.refresh_command = metadata.refresh_command
  }
}
