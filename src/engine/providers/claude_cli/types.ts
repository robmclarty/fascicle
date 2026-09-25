/**
 * Public types for the claude_cli subprocess provider.
 *
 * Value fields are snake_case; exported type aliases are PascalCase. These
 * types are re-exported from `src/engine/index.ts` so callers can
 * narrow provider-scoped options and provider_reported values at their use
 * site.
 */

export type AuthMode = 'auto' | 'oauth' | 'api_key'

export type ToolBridgeMode = 'allowlist_only' | 'forbid'

export type SandboxProviderConfig =
  | {
      readonly kind: 'bwrap'
      readonly network_allowlist?: ReadonlyArray<string>
      readonly additional_write_paths?: ReadonlyArray<string>
    }
  | {
      readonly kind: 'greywall'
      readonly network_allowlist?: ReadonlyArray<string>
      readonly additional_write_paths?: ReadonlyArray<string>
      /**
       * greywall 0.3+ takes filesystem/network policy from a JSON settings
       * file. By default the adapter writes a temp settings file derived
       * from `network_allowlist`/`additional_write_paths`. Set to forward
       * a caller-managed settings file directly via `--settings` instead.
       * The temp-file path is then skipped entirely.
       */
      readonly settings_path?: string
    }

export type ClaudeCliProviderConfig = {
  readonly binary?: string
  readonly auth_mode?: AuthMode
  readonly api_key?: string
  /**
   * The subprocess env seeds the standard process-env keys
   * (PATH/HOME/SHELL/USER/LOGNAME/LANG/TMPDIR) by default under every
   * auth mode so the spawn target (sandbox wrapper or the claude binary)
   * can be resolved on PATH. Under `auth_mode: 'oauth'` the *full*
   * `process.env` is inherited so the CLI can reach the logged-in OAuth
   * session. Set to `false` to opt out and start from an empty env.
   */
  readonly inherit_env?: boolean
  readonly default_cwd?: string
  readonly startup_timeout_ms?: number
  readonly stall_timeout_ms?: number
  readonly setting_sources?: ReadonlyArray<'user' | 'project' | 'local'>
  readonly plugin_dirs?: ReadonlyArray<string>
  readonly sandbox?: SandboxProviderConfig
  readonly skip_probe?: boolean
}

export type AgentDef = {
  readonly description: string
  readonly prompt: string
  readonly model?: string
}

export type ClaudeCliCallOptions = {
  readonly allowed_tools?: ReadonlyArray<string>
  readonly agents?: Record<string, AgentDef>
  readonly session_id?: string
  readonly append_system_prompt?: string
  readonly output_json_schema?: string
  readonly tool_bridge?: ToolBridgeMode
  readonly extra_args?: ReadonlyArray<string>
  readonly env?: Record<string, string>
}

/**
 * What the claude CLI's terminal `result` event reports about a run, found
 * under `provider_reported['claude_cli']`. Read it with `claude_cli_reported`.
 */
export type ClaudeCliProviderReported = {
  readonly session_id: string
  /** The CLI's own wall clock for the run, tool execution included. */
  readonly duration_ms: number
  /**
   * Time the run spent in API requests, summed across its turns. Present
   * when the CLI reports it. The adapter splits it across the run's steps
   * by output tokens (the split its cost uses) to give each step a blended
   * `StepTiming`, laid end to end from the run's start.
   */
  readonly duration_api_ms?: number
}
