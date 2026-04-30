/**
 * Public type surface for the AI engine layer.
 *
 * Type aliases and interfaces use PascalCase per constraints §2. Value-level
 * field names remain snake_case.
 *
 * Shared runtime types (TrajectoryLogger, TrajectoryEvent, RunContext) live in
 * @repo/core. The engine imports them via `import type` only; no value
 * import from core is permitted anywhere in packages/engine/src/.
 */

import type { z } from 'zod'
import type { TrajectoryLogger } from '@repo/core'
import type { ClaudeCliProviderConfig } from './providers/claude_cli/types.js'

export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type FinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'aborted'
  | 'max_steps'

export type RetryFailureKind =
  | 'rate_limit'
  | 'provider_5xx'
  | 'network'
  | 'timeout'

export type RetryPolicy = {
  max_attempts: number
  initial_delay_ms: number
  max_delay_ms: number
  retry_on: ReadonlyArray<RetryFailureKind>
}

export type AliasTarget = {
  provider: string
  model_id: string
  defaults?: {
    temperature?: number
    max_tokens?: number
    effort?: EffortLevel
  }
}

export type AliasTable = Readonly<Record<string, AliasTarget>>

export type Pricing = {
  input_per_million: number
  output_per_million: number
  cached_input_per_million?: number
  cache_write_per_million?: number
  reasoning_per_million?: number
}

export type PricingTable = Readonly<Record<string, Pricing>>

export type UsageTotals = {
  input_tokens: number
  output_tokens: number
  reasoning_tokens?: number
  cached_input_tokens?: number
  cache_write_tokens?: number
}

export type CostBreakdown = {
  total_usd: number
  input_usd: number
  output_usd: number
  cached_input_usd?: number
  cache_write_usd?: number
  reasoning_usd?: number
  currency: 'USD'
  is_estimate: true
}

export type ToolCallRecord = {
  id: string
  name: string
  input: unknown
  output?: unknown
  error?: { message: string; stack?: string }
  duration_ms: number
  started_at: number
}

export type StepRecord = {
  index: number
  text: string
  tool_calls: ToolCallRecord[]
  usage: UsageTotals
  cost?: CostBreakdown
  finish_reason: FinishReason
}

export type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: Uint8Array | string; media_type?: string }

export type AssistantContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentPart[] }
  | { role: 'assistant'; content: string | AssistantContentPart[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string }

export type ToolExecContext = {
  abort: AbortSignal
  trajectory?: TrajectoryLogger
  tool_call_id: string
  step_index: number
}

export type Tool<i = unknown, o = unknown> = {
  name: string
  description: string
  input_schema: z.ZodType<i>
  execute: (input: i, ctx: ToolExecContext) => Promise<o> | o
  needs_approval?: boolean | ((input: i) => boolean | Promise<boolean>)
}

export type ToolApprovalRequest = {
  tool_name: string
  input: unknown
  step_index: number
  abort: AbortSignal
}

export type ToolApprovalHandler = (
  request: ToolApprovalRequest,
) => boolean | Promise<boolean>

export type StreamChunk =
  | { kind: 'text'; text: string; step_index: number }
  | { kind: 'reasoning'; text: string; step_index: number }
  | { kind: 'tool_call_start'; id: string; name: string; step_index: number }
  | { kind: 'tool_call_input_delta'; id: string; delta: string; step_index: number }
  | { kind: 'tool_call_end'; id: string; input: unknown; step_index: number }
  | {
      kind: 'tool_result'
      id: string
      output?: unknown
      error?: { message: string }
      step_index: number
    }
  | {
      kind: 'step_finish'
      step_index: number
      finish_reason: FinishReason
      usage: UsageTotals
    }
  | { kind: 'finish'; finish_reason: FinishReason; usage: UsageTotals }

export type GenerateOptions<t = string> = {
  model?: string
  prompt: string | Message[]
  system?: string
  schema?: z.ZodType<t>
  tools?: Tool[]
  effort?: EffortLevel
  temperature?: number
  max_tokens?: number
  top_p?: number
  max_steps?: number
  abort?: AbortSignal
  trajectory?: TrajectoryLogger
  on_chunk?: (chunk: StreamChunk) => void | Promise<void>
  retry?: RetryPolicy
  tool_error_policy?: 'feed_back' | 'throw'
  schema_repair_attempts?: number
  on_tool_approval?: ToolApprovalHandler
  provider_options?: Record<string, unknown>
}

export type GenerateResult<t = string> = {
  content: t
  tool_calls: ToolCallRecord[]
  steps: StepRecord[]
  usage: UsageTotals
  cost?: CostBreakdown
  finish_reason: FinishReason
  model_resolved: { provider: string; model_id: string }
  provider_reported?: Record<string, unknown>
}

export type ProviderInit = {
  api_key?: string
  base_url?: string
  [k: string]: unknown
}

export type ProviderConfigMap = {
  anthropic?: { api_key: string; base_url?: string }
  openai?: { api_key: string; base_url?: string; organization?: string }
  google?: { api_key: string; base_url?: string }
  ollama?: { base_url: string }
  lmstudio?: { base_url: string }
  openrouter?: {
    api_key: string
    base_url?: string
    http_referer?: string
    x_title?: string
  }
  claude_cli?: ClaudeCliProviderConfig
  [custom: string]: ProviderInit | undefined
}

/**
 * Call-level defaults applied by the engine before dispatching to a provider.
 *
 * Per-call options from `generate(opts)` win over defaults using these rules:
 *
 * | Field                                                                 | Rule                                      |
 * | --------------------------------------------------------------------- | ----------------------------------------- |
 * | `model`                                                               | per-call wins; else default; else throw    |
 * | `system`, `effort`, `max_steps`, `tool_error_policy`, `schema_repair_attempts` | per-call wins (nullish coalesce) |
 * | `retry_policy`                                                        | per-call replaces wholesale                |
 * | `provider_options`                                                    | two-level: per-provider-key shallow merge  |
 * | `prompt`, `tools`, `schema`, `abort`, `trajectory`, `on_chunk`        | not defaultable; always call-supplied      |
 */
export type EngineDefaults = {
  readonly model?: string
  readonly system?: string
  readonly effort?: EffortLevel
  readonly max_steps?: number
  readonly retry_policy?: RetryPolicy
  readonly tool_error_policy?: 'feed_back' | 'throw'
  readonly schema_repair_attempts?: number
  readonly provider_options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export type EngineConfig = {
  providers: ProviderConfigMap
  aliases?: AliasTable
  pricing?: PricingTable
  default_retry?: RetryPolicy
  default_effort?: EffortLevel
  default_max_steps?: number
  defaults?: EngineDefaults
}

export type Engine = {
  generate: <t = string>(opts: GenerateOptions<t>) => Promise<GenerateResult<t>>
  register_alias: (alias: string, target: AliasTarget) => void
  unregister_alias: (alias: string) => void
  resolve_alias: (alias: string) => AliasTarget
  list_aliases: () => AliasTable
  register_price: (provider: string, model_id: string, pricing: Pricing) => void
  resolve_price: (provider: string, model_id: string) => Pricing | undefined
  list_prices: () => PricingTable
  dispose: () => Promise<void>
}
