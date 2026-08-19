/**
 * Authentication enforcement for the claude_cli adapter.
 *
 * Composes the subprocess environment from provider config and call-level
 * overrides, validates that `auth_mode: 'api_key'` has a key to use, and
 * recognizes CLI stderr auth failures so they can be surfaced as
 * `provider_auth_error` instead of a generic exit-code error.
 */

import { engine_config_error } from '../../errors.js'
import type { AuthMode, ClaudeCliProviderConfig } from './types.js'
import { CLI_AUTH_ERROR_PATTERNS } from './constants.js'

/**
 * Standard env keys forwarded from process.env so the spawn target
 * (greywall/bwrap on PATH, then `claude`) can be resolved and run.
 *
 * Mirrors `STANDARD_KEYS` in `src/forward_standard_env.ts`. Keep the two
 * lists in sync; engine cannot import from Fascicle (the umbrella depends
 * on engine, not the other way).
 */
const STANDARD_ENV_KEYS = [
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'TMPDIR',
] as const

/**
 * Throw `engine_config_error` synchronously when `auth_mode: 'api_key'` is
 * set without a non-empty `api_key`.
 *
 * Runs at adapter construction time so a misconfigured provider fails
 * fast, before any CLI subprocess is spawned.
 */
export function validate_auth_config(config: ClaudeCliProviderConfig): void {
  const auth_mode = config.auth_mode ?? 'auto'
  if (auth_mode === 'api_key') {
    const api_key = typeof config.api_key === 'string' ? config.api_key : ''
    if (api_key.length === 0) {
      throw new engine_config_error(
        'api_key is required for auth_mode: api_key',
        'claude_cli',
      )
    }
  }
}

/**
 * Copy the string-valued entries of `source` onto `target`, dropping any
 * `undefined` slot (the shape `process.env` and caller overrides both carry).
 */
function copy_string_entries(
  target: Record<string, string>,
  source: Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') target[key] = value
  }
}

/**
 * Seed the base subprocess env before caller overrides and the auth scrub.
 *
 * `inherit_env: false` starts from an empty env. Otherwise `'oauth'` inherits
 * the full `process.env` (the CLI needs HOME plus session-specific vars to
 * reach the logged-in session); every other mode inherits only the standard
 * keys needed to resolve the sandbox wrapper and the claude binary on PATH.
 */
function seed_base_env(
  config: ClaudeCliProviderConfig,
  auth_mode: AuthMode,
): Record<string, string> {
  const env: Record<string, string> = {}
  if (config.inherit_env === false) return env
  if (auth_mode === 'oauth') {
    copy_string_entries(env, process.env)
    return env
  }
  for (const key of STANDARD_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string') env[key] = value
  }
  return env
}

/**
 * Apply the auth-mode scrub last, after base and caller env are merged, so
 * nothing can re-introduce `ANTHROPIC_API_KEY` under `'oauth'`. `'api_key'`
 * forces the configured key (empty string when absent); `'auto'` forwards a
 * non-empty configured key and otherwise leaves the inherited env untouched.
 */
function apply_auth_key(
  env: Record<string, string>,
  config: ClaudeCliProviderConfig,
  auth_mode: AuthMode,
): void {
  if (auth_mode === 'oauth') {
    delete env['ANTHROPIC_API_KEY']
    return
  }
  if (auth_mode === 'api_key') {
    env['ANTHROPIC_API_KEY'] = typeof config.api_key === 'string' ? config.api_key : ''
    return
  }
  if (typeof config.api_key === 'string' && config.api_key.length > 0) {
    env['ANTHROPIC_API_KEY'] = config.api_key
  }
}

/**
 * Compose the subprocess environment for one claude CLI invocation.
 *
 * Regardless of `auth_mode`, seeds the standard process-env keys (PATH,
 * HOME, SHELL, USER, LOGNAME, LANG, TMPDIR) by default so the spawned
 * subprocess can locate the sandbox wrapper (greywall/bwrap) and the
 * claude binary on PATH. Set `inherit_env: false` on the provider config to
 * opt out and start from an empty env instead.
 *
 * Under `auth_mode: 'oauth'` the full `process.env` is inherited instead
 * of just the standard keys, because the CLI needs HOME plus
 * session-specific vars to reach the already-logged-in OAuth session. The
 * auth-mode scrub runs last, after config and caller overrides are merged
 * in, so nothing can re-introduce `ANTHROPIC_API_KEY` under `'oauth'`.
 */
export function build_env(
  config: ClaudeCliProviderConfig,
  caller_env: Record<string, string> | undefined,
  auth_mode: AuthMode,
): Record<string, string> {
  const env = seed_base_env(config, auth_mode)
  if (caller_env !== undefined) copy_string_entries(env, caller_env)
  apply_auth_key(env, config, auth_mode)
  return env
}

/**
 * Check whether captured CLI stderr looks like an auth failure.
 *
 * Matches case-insensitively against the frozen `CLI_AUTH_ERROR_PATTERNS`
 * list; used to turn a nonzero CLI exit into `provider_auth_error` instead
 * of a generic `claude_cli_error`.
 */
export function stderr_is_auth_failure(stderr: string): boolean {
  if (stderr.length === 0) return false
  const lower = stderr.toLowerCase()
  for (const pattern of CLI_AUTH_ERROR_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) return true
  }
  return false
}
