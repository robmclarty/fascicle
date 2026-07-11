/**
 * Public entry point for engine.
 *
 * Exposes `create_engine(config)` and re-exports every public type and typed
 * error from spec §5 / §9, plus the provider-authoring surface
 * (`ProviderFactory`, the adapter union, the neutral turn types
 * `TurnRequest`/`TurnResult`, and `default_normalize_usage`) for
 * `custom_providers`. Built-in adapters and internal orchestration helpers
 * are not re-exported.
 */

export { create_engine } from './create_engine.js'

export type {
  AiSdkTelemetrySettings,
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
  PrepareStepContext,
  PrepareStepHook,
  PrepareStepResult,
  Pricing,
  PricingTable,
  ProviderConfigMap,
  ProviderInit,
  ResolvedModel,
  RetryFailureKind,
  RetryPolicy,
  StepRecord,
  StreamChunk,
  Tool,
  ToolApprovalHandler,
  ToolApprovalRequest,
  ToolCallRecord,
  ToolExecContext,
  TurnRequest,
  TurnResult,
  UsageTotals,
  UserContentPart,
} from './types.js'

export type {
  AiSdkProviderAdapter,
  EffortTranslation,
  ExternalAgentAdapter,
  NativeProviderAdapter,
  ProviderAdapter,
  ProviderCapability,
  ProviderFactory,
  ProviderTransport,
  RawProviderUsage,
} from './providers/types.js'

export { default_normalize_usage } from './providers/types.js'

export type {
  AgentDef,
  AuthMode,
  ClaudeCliCallOptions,
  ClaudeCliProviderConfig,
  ClaudeCliProviderReported,
  SandboxProviderConfig,
  ToolBridgeMode,
} from './providers/claude_cli/types.js'

export {
  aborted_error,
  claude_cli_error,
  engine_config_error,
  engine_disposed_error,
  model_required_error,
  on_chunk_error,
  provider_auth_error,
  provider_capability_error,
  provider_error,
  provider_not_configured_error,
  rate_limit_error,
  schema_validation_error,
  tool_approval_denied_error,
  tool_error,
} from './errors.js'
