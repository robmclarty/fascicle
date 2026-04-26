/**
 * Frozen constants for the claude_cli provider (spec §5.1 defaults, §6.3
 * escalation window, §10.2 cost decomposition multipliers, §11 F19 auth
 * pattern list).
 *
 * Arrays are Object.freeze-d at module load so downstream code cannot mutate
 * them (constraints §7 invariant 25).
 */

export const CLI_BINARY_DEFAULT = 'claude';

export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;

export const DEFAULT_STALL_TIMEOUT_MS = 300_000;

export const SIGKILL_ESCALATION_MS = 2000;

export const CACHE_READ_MULTIPLIER = 0.1;

export const CACHE_WRITE_MULTIPLIER = 1.25;

export const CLI_AUTH_ERROR_PATTERNS: ReadonlyArray<string> = Object.freeze([
  'authentication',
  'unauthorized',
  'forbidden',
  'oauth token has expired',
  'invalid_api_key',
]);

export const DEFAULT_SETTING_SOURCES: ReadonlyArray<'user' | 'project' | 'local'> =
  Object.freeze(['project', 'local']);
