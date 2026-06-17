/**
 * Returns the standard set of env vars a typical CLI subprocess needs
 * to reach a user's logged-in session: PATH, HOME, SHELL, USER,
 * LOGNAME, LANG, TMPDIR. Values absent from `process.env` are skipped.
 *
 * Useful when passing explicit env to `claude_cli` under api_key mode
 * (oauth mode inherits automatically), or when you want an explicit,
 * minimal allowlist instead of inheriting the full parent env.
 *
 * @example
 *   provider_options: {
 *     claude_cli: { env: forward_standard_env() },
 *   }
 */
const STANDARD_KEYS = ['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'TMPDIR'] as const

export function forward_standard_env(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of STANDARD_KEYS) {
    const v = process.env[key]
    if (typeof v === 'string') out[key] = v
  }
  return out
}
