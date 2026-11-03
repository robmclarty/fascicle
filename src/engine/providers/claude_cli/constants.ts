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

/**
 * The command that logs the CLI in again, which an auth failure's message
 * names and its `refresh_command` carries.
 */
export const CLI_REFRESH_COMMAND = 'claude auth login'

/**
 * The variable that runs the CLI in bare mode, the same as passing `--bare`.
 * Bare mode never reads the CLI's login, so an `oauth` call scrubs it.
 */
export const CLI_BARE_MODE_ENV = 'CLAUDE_CODE_SIMPLE'

/**
 * The oldest Claude Code that honors every key the `claude_code` sandbox
 * renders, as `[major, minor, patch]`. 2.1.314 added
 * `blockWritesOutsideWorkingDirectories`, the newest of them, and an older
 * CLI drops a key it doesn't know without a word, which would leave the
 * file tools unconfined.
 */
export const CLAUDE_CODE_SANDBOX_MIN_VERSION: readonly [number, number, number] =
  Object.freeze([2, 1, 314] as const)

export const DEFAULT_SETTING_SOURCES: ReadonlyArray<'user' | 'project' | 'local'> =
  Object.freeze(['project', 'local'])
