/**
 * Umbrella entry point for fascicle.
 *
 * Re-exports the full public surface of `@repo/core` (composition
 * layer) plus `@repo/engine` (AI engine layer) so downstream apps
 * can install a single package.
 *
 * `aborted_error` lives in core and is re-exported by engine, so both
 * layers surface the same class (NOTES.md D5). Core and engine each expose
 * their own `version` constant; the umbrella renames them to `core_version`
 * and `engine_version` — there is no unqualified `version` winner (D6).
 *
 * `model_call` is the sole sanctioned bridge between the two layers; it is
 * the only file under packages/fascicle/src/ that imports values from both
 * @repo/core and @repo/engine (enforced by model-call-is-sole-bridge).
 */

export * from '@repo/core';

export { create_engine } from '@repo/engine';

export {
  engine_config_error,
  model_not_found_error,
  on_chunk_error,
  provider_capability_error,
  provider_error,
  provider_not_configured_error,
  rate_limit_error,
  schema_validation_error,
  tool_approval_denied_error,
  tool_error,
  version as engine_version,
} from '@repo/engine';

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
} from '@repo/engine';

export { model_call } from './model_call.js';
export type { ModelCallConfig, ModelCallInput } from './model_call.js';

export { forward_standard_env } from './forward_standard_env.js';
