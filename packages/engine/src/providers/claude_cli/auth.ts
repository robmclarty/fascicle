/**
 * Authentication enforcement for the claude_cli adapter (spec §4, §6.1).
 *
 * - build_env composes the subprocess env from config + caller overrides.
 *   Under `auth_mode: 'oauth'` it seeds from `process.env` (the CLI needs
 *   HOME/PATH to reach the logged-in session) unless `config.inherit_env`
 *   is explicitly `false`. Under 'api_key' and 'auto' it starts empty and
 *   only copies caller-supplied keys. Auth-mode scrub runs last on the
 *   merged result so nothing — caller env, inherited env, or config —
 *   can re-introduce ANTHROPIC_API_KEY under 'oauth'.
 * - validate_auth_config throws engine_config_error synchronously when
 *   auth_mode === 'api_key' without a non-empty api_key.
 * - stderr_is_auth_failure matches captured stderr against the frozen
 *   CLI_AUTH_ERROR_PATTERNS list, case-insensitively.
 */

import { engine_config_error } from '../../errors.js'
import type { AuthMode, ClaudeCliProviderConfig } from './types.js'
import { CLI_AUTH_ERROR_PATTERNS } from './constants.js'

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

export function build_env(
  config: ClaudeCliProviderConfig,
  caller_env: Record<string, string> | undefined,
  auth_mode: AuthMode,
): Record<string, string> {
  const env: Record<string, string> = {}
  const should_inherit = auth_mode === 'oauth' && config.inherit_env !== false
  if (should_inherit) {
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
  }
  if (caller_env !== undefined) {
    for (const [k, v] of Object.entries(caller_env)) {
      if (typeof v === 'string') env[k] = v
    }
  }
  if (auth_mode === 'oauth') {
    delete env['ANTHROPIC_API_KEY']
    return env
  }
  if (auth_mode === 'api_key') {
    const api_key = typeof config.api_key === 'string' ? config.api_key : ''
    env['ANTHROPIC_API_KEY'] = api_key
    return env
  }
  if (typeof config.api_key === 'string' && config.api_key.length > 0) {
    env['ANTHROPIC_API_KEY'] = config.api_key
  }
  return env
}

export function stderr_is_auth_failure(stderr: string): boolean {
  if (stderr.length === 0) return false
  const lower = stderr.toLowerCase()
  for (const pattern of CLI_AUTH_ERROR_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) return true
  }
  return false
}
