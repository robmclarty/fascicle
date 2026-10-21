/**
 * Frozen constants for the claude_cli provider: startup and idle defaults,
 * the escalation window, and the auth failure pattern list.
 *
 * Arrays are Object.freeze-d at module load so downstream code cannot mutate
 * them.
 */

export const CLI_BINARY_DEFAULT = 'claude'

export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000

export const DEFAULT_STALL_TIMEOUT_MS = 300_000

export const SIGKILL_ESCALATION_MS = 2000

export const CLI_AUTH_ERROR_PATTERNS: ReadonlyArray<string> = Object.freeze([
  'authentication',
  'unauthorized',
  'forbidden',
  'oauth token has expired',
  'invalid_api_key',
])

/**
 * The error code on the assistant message that the CLI writes in the model's
 * place when it has no session to call with. It goes to stdout, not stderr,
 * so `CLI_AUTH_ERROR_PATTERNS` never sees it.
 */
export const CLI_AUTH_FAILED_ERROR = 'authentication_failed'

export const DEFAULT_SETTING_SOURCES: ReadonlyArray<'user' | 'project' | 'local'> =
  Object.freeze(['project', 'local'])
