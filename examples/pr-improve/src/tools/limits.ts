/**
 * Hard limits applied to the worktree-scoped builder tools (Phase C).
 *
 * Centralized so tests can reference the same constants and the SPEC.md
 * limits table stays a single source of truth.
 */

export const MAX_FILE_BYTES = 256 * 1024
export const MAX_LIST_ENTRIES = 1000
export const MAX_SHELL_OUT_BYTES = 64 * 1024
export const SHELL_TIMEOUT_MS = 60_000
