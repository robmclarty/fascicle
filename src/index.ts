/**
 * Umbrella entry point for fascicle.
 *
 * Re-exports the full public surface of `core` (composition
 * layer) plus `engine` (AI engine layer) so downstream apps
 * can install a single package.
 *
 * `aborted_error` lives in core and is re-exported by engine, so both
 * layers surface the same class (NOTES.md D5).
 *
 * `model_call` is the sole sanctioned bridge between the two layers; it is
 * the only file under packages/fascicle/src/ that imports values from both
 * core and engine (enforced by model-call-is-sole-bridge).
 */

export * from '#core'
export * from '#composites'

export { create_engine } from '#engine'

export {
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
} from '#engine'

export type {
  AiSdkProviderAdapter,
  AssistantContentPart,
  CostBreakdown,
  EffortLevel,
  EffortTranslation,
  Engine,
  EngineConfig,
  EngineDefaults,
  ExternalAgentAdapter,
  FinishReason,
  GenerateOptions,
  GenerateResult,
  Message,
  NativeProviderAdapter,
  Pricing,
  PricingTable,
  ProviderAdapter,
  ProviderCapability,
  ProviderConfigMap,
  ProviderFactory,
  ProviderInit,
  ProviderTransport,
  RawProviderUsage,
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
} from '#engine'

export { default_normalize_usage } from '#engine'

export { model_call } from './model_call.js'
export type { ModelCallConfig, ModelCallInput } from './model_call.js'

export { forward_standard_env } from './forward_standard_env.js'

export { run_viewer_cli, start_viewer } from '#viewer'
export type { StartViewerOptions, ViewerHandle } from '#viewer'
