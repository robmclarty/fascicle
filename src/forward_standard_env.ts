/**
 * Env forwarding allowlist for CLI subprocesses.
 *
 * Useful when passing explicit env to `claude_cli` under api_key mode
 * (oauth mode inherits the parent env automatically), or whenever an
 * explicit, minimal allowlist is preferred over inheriting the full parent
 * env.
 */
const STANDARD_KEYS = ['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'] as const

/**
 * Return the standard env vars a CLI subprocess needs to reach a user's
 * logged-in session: PATH, HOME, SHELL, USER, LOGNAME, LANG, TMPDIR.
 *
 * Keys absent from `process.env` are skipped.
 *
 * @example
 *   provider_options: {
 *     claude_cli: { env: forward_standard_env() },
 *   }
 */
export function forward_standard_env(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of STANDARD_KEYS) {
    const v = process.env[key]
    if (typeof v === 'string') out[key] = v
  }
  return out
}
