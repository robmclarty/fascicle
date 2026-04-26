/**
 * Public types for the claude_cli subprocess provider (spec §5.1, §5.3, §5.4).
 *
 * Value fields are snake_case; exported type aliases are PascalCase. These
 * types are re-exported from packages/engine/src/index.ts so callers can
 * narrow provider-scoped options and provider_reported values at their use
 * site.
 */

export type AuthMode = 'auto' | 'oauth' | 'api_key';

export type ToolBridgeMode = 'allowlist_only' | 'forbid';

export type SandboxProviderConfig =
  | {
      readonly kind: 'bwrap';
      readonly network_allowlist?: ReadonlyArray<string>;
      readonly additional_write_paths?: ReadonlyArray<string>;
    }
  | {
      readonly kind: 'greywall';
      readonly network_allowlist?: ReadonlyArray<string>;
      readonly additional_write_paths?: ReadonlyArray<string>;
    };

export type ClaudeCliProviderConfig = {
  readonly binary?: string;
  readonly auth_mode?: AuthMode;
  readonly api_key?: string;
  /**
   * Under `auth_mode: 'oauth'` the subprocess env seeds from `process.env`
   * by default so it can reach the logged-in `claude` session. Set to
   * `false` to opt out and start from an empty env (the api_key-mode
   * default). Ignored outside oauth mode.
   */
  readonly inherit_env?: boolean;
  readonly default_cwd?: string;
  readonly startup_timeout_ms?: number;
  readonly stall_timeout_ms?: number;
  readonly setting_sources?: ReadonlyArray<'user' | 'project' | 'local'>;
  readonly plugin_dirs?: ReadonlyArray<string>;
  readonly sandbox?: SandboxProviderConfig;
  readonly skip_probe?: boolean;
};

export type AgentDef = {
  readonly description: string;
  readonly prompt: string;
  readonly model?: string;
};

export type ClaudeCliCallOptions = {
  readonly allowed_tools?: ReadonlyArray<string>;
  readonly agents?: Record<string, AgentDef>;
  readonly session_id?: string;
  readonly append_system_prompt?: string;
  readonly output_json_schema?: string;
  readonly tool_bridge?: ToolBridgeMode;
  readonly extra_args?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
};

export type ClaudeCliProviderReported = {
  readonly session_id: string;
  readonly duration_ms: number;
};
