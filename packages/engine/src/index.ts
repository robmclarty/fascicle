/**
 * Public entry point for @repo/engine.
 *
 * Exposes `create_engine(config)` and re-exports every public type and typed
 * error from spec §5 / §9. Provider adapters and internal orchestration
 * helpers are not re-exported.
 */

export { version } from './version.js';

export { create_engine } from './create_engine.js';

export type {
  AliasTarget,
  AliasTable,
  AssistantContentPart,
  CostBreakdown,
  EffortLevel,
  Engine,
  EngineConfig,
  EngineDefaults,
  FinishReason,
  GenerateOptions,
  GenerateResult,
  Message,
  Pricing,
  PricingTable,
  ProviderConfigMap,
  ProviderInit,
  RetryFailureKind,
  RetryPolicy,
  StepRecord,
  StreamChunk,
  Tool,
  ToolApprovalHandler,
  ToolApprovalRequest,
  ToolCallRecord,
  ToolExecContext,
  UsageTotals,
  UserContentPart,
} from './types.js';

export type {
  AgentDef,
  AuthMode,
  ClaudeCliCallOptions,
  ClaudeCliProviderConfig,
  ClaudeCliProviderReported,
  SandboxProviderConfig,
  ToolBridgeMode,
} from './providers/claude_cli/types.js';

export {
  aborted_error,
  claude_cli_error,
  engine_config_error,
  engine_disposed_error,
  model_not_found_error,
  on_chunk_error,
  provider_auth_error,
  provider_capability_error,
  provider_error,
  provider_not_configured_error,
  rate_limit_error,
  schema_validation_error,
  tool_approval_denied_error,
  tool_error,
} from './errors.js';
