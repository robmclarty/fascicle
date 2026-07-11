/**
 * Public type surface for the AI engine layer.
 *
 * Type aliases and interfaces use PascalCase per constraints §2. Value-level
 * field names remain snake_case.
 *
 * Shared runtime types (TrajectoryLogger, TrajectoryEvent, RunContext) live in
 * core. The engine imports them via `import type` only; no value
 * import from core is permitted anywhere in packages/engine/src/.
 */

import type { z } from 'zod'
import type { TrajectoryLogger } from '#core'
import type { ClaudeCliProviderConfig } from './providers/claude_cli/types.js'
import type { ProviderFactory, ProviderTransport } from './providers/types.js'

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

/**
 * The resolved transport + model id a generate call dispatches to. `model_id`
 * is passed verbatim to the provider; the engine does not interpret it.
 */
export type ResolvedModel = {
  provider: string
  model_id: string
}

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

export type SalvageFormat = 'hermes' | 'json' | 'qwen_xml'

export type ToolCallRecord = {
  id: string
  name: string
  input: unknown
  output?: unknown
  error?: { message: string; stack?: string }
  duration_ms: number
  started_at: number
  /**
   * Present only when the call was recovered from assistant text rather than
   * returned structurally by the provider (tool_call_repair_attempts > 0).
   */
  salvaged?: true
  salvaged_format?: SalvageFormat
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
  /**
   * When true, a SUCCESSFUL execution of this tool ends the tool loop
   * deterministically: the loop executes the call (recording its output and
   * trajectory events like any tool), then stops instead of running another
   * model turn. A denied, invalid, dropped, or throwing terminal call does NOT
   * end the loop. undefined (the default) preserves the prior loop exactly.
   */
  ends_turn?: boolean
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

/**
 * Neutral single-turn result shared by every depth-1 transport (`ai_sdk`,
 * `native`). The tool-call loop consumes it through InvokeOnce; a native
 * adapter's invoke_turn produces it directly. Staying provider-agnostic here is
 * what lets salvage, approval, cost, and retry sit in one loop above any
 * transport rather than being reimplemented per provider.
 */
export type TurnResult = {
  readonly text: string
  readonly tool_calls: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly input: unknown
  }>
  readonly finish_reason: FinishReason
  readonly usage: UsageTotals
}

/**
 * One turn's resolved request handed to a native adapter's invoke_turn.
 * generate.ts assembles it from GenerateOptions plus engine defaults (resolved
 * system, effort, merged provider_options, sampling params). When `stream` is
 * true `dispatch_chunk` is defined and the adapter MUST emit StreamChunks
 * through it while still returning the fully aggregated TurnResult.
 */
export type TurnRequest = {
  readonly step_index: number
  readonly messages: ReadonlyArray<Message>
  readonly tools: ReadonlyArray<Tool>
  readonly abort: AbortSignal
  readonly stream: boolean
  readonly model_id: string
  readonly system?: string
  readonly schema?: z.ZodType
  readonly effort: EffortLevel
  readonly provider_options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly temperature?: number
  readonly max_tokens?: number
  readonly top_p?: number
  readonly dispatch_chunk?: (chunk: StreamChunk) => Promise<void>
}

/**
 * Context handed to a prepare_step hook (D6): the turn's index and the
 * would-be request messages (the full accumulated transcript at that point in
 * the loop). Kept minimal by design; per-step model/effort switching is out of
 * scope (Open question N-Q1).
 */
export type PrepareStepContext = {
  readonly step_index: number
  readonly messages: ReadonlyArray<Message>
}

/**
 * A prepare_step return: `{ messages }` replaces the request for that turn,
 * `undefined` (or an object without `messages`) is a no-op.
 */
export type PrepareStepResult = { messages?: ReadonlyArray<Message> } | undefined

/**
 * Per-turn message hook (D6). run_tool_loop calls it before each turn on every
 * depth-1 transport. Returning replacement messages reshapes ONLY what is sent
 * to the model for that turn (pruning, summarizing, windowing); the canonical
 * transcript the loop appends to is untouched, so salvage, approval,
 * Tool.ends_turn, and schema-repair keep operating on the real history. May be
 * sync or async.
 */
export type PrepareStepHook = (
  ctx: PrepareStepContext,
) => PrepareStepResult | Promise<PrepareStepResult>

export type GenerateOptions<t = string> = {
  model?: string
  provider?: string
  prompt: string | Message[]
  system?: string
  schema?: z.ZodType<t>
  tools?: Tool[]
  effort?: EffortLevel
  temperature?: number
  max_tokens?: number
  top_p?: number
  max_steps?: number
  /**
   * Per-turn wall-clock budget in milliseconds. When set, the engine composes
   * a timeout signal with `abort` around every depth-1 turn (D5); expiry before
   * any chunk streams throws a retryable timeout, while an expiry after chunks
   * have flowed becomes a non-retryable stream interruption. undefined (the
   * default) leaves turns unbounded. Must be > 0.
   */
  turn_timeout_ms?: number
  abort?: AbortSignal
  trajectory?: TrajectoryLogger
  on_chunk?: (chunk: StreamChunk) => void | Promise<void>
  retry?: RetryPolicy
  tool_error_policy?: 'feed_back' | 'throw'
  schema_repair_attempts?: number
  /**
   * Budget for salvaging tool calls the model emitted as assistant text
   * instead of structured tool_calls (a common local-runtime failure).
   * 0 (the default) disables salvage entirely. The budget is shared across
   * the whole generate call, including schema-repair re-invocations.
   */
  tool_call_repair_attempts?: number
  /**
   * Cap on tool calls executed per step. Calls beyond the cap are dropped
   * for that step (the model can re-issue them next turn) and surfaced via
   * ToolCallRecord errors and a tool_calls_dropped trajectory event.
   * undefined (the default) leaves the count unlimited.
   */
  max_tool_calls_per_step?: number
  on_tool_approval?: ToolApprovalHandler
  /**
   * Per-turn hook to reshape the messages sent to the model without mutating
   * the canonical transcript (D6). Called before every turn with the step
   * index and the would-be request messages; return `{ messages }` to
   * prune/replace that turn's request or undefined for a no-op. A
   * `step_prepared` trajectory event records every turn it replaced. See
   * PrepareStepHook.
   */
  prepare_step?: PrepareStepHook
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
  anthropic?: { api_key: string; base_url?: string; transport?: ProviderTransport }
  openai?: { api_key: string; base_url?: string; organization?: string; transport?: ProviderTransport }
  google?: { api_key: string; base_url?: string }
  ollama?: { base_url: string; transport?: ProviderTransport }
  lmstudio?: { base_url: string; transport?: ProviderTransport }
  openrouter?: {
    api_key: string
    base_url?: string
    http_referer?: string
    x_title?: string
    transport?: ProviderTransport
  }
  bedrock?: {
    region: string
    api_key?: string
    access_key_id?: string
    secret_access_key?: string
    session_token?: string
    base_url?: string
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
 * | `model`                                                               | per-call wins; else default; else `sonnet` |
 * | `provider`                                                            | per-call wins; else default; else sole configured provider; else `anthropic` |
 * | `system`, `effort`, `max_steps`, `turn_timeout_ms`, `tool_error_policy`, `schema_repair_attempts`, `tool_call_repair_attempts`, `max_tool_calls_per_step` | per-call wins (nullish coalesce) |
 * | `retry_policy`                                                        | per-call replaces wholesale                |
 * | `provider_options`                                                    | two-level: per-provider-key shallow merge  |
 * | `prompt`, `tools`, `schema`, `abort`, `trajectory`, `on_chunk`        | not defaultable; always call-supplied      |
 */
export type EngineDefaults = {
  readonly model?: string
  readonly provider?: string
  readonly system?: string
  readonly effort?: EffortLevel
  readonly max_steps?: number
  readonly turn_timeout_ms?: number
  readonly retry_policy?: RetryPolicy
  readonly tool_error_policy?: 'feed_back' | 'throw'
  readonly schema_repair_attempts?: number
  readonly tool_call_repair_attempts?: number
  readonly max_tool_calls_per_step?: number
  readonly provider_options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export type EngineConfig = {
  providers: ProviderConfigMap
  /**
   * Construction-time provider registry extension. Keys are provider names,
   * resolved custom-first against the built-ins; a key that shadows a built-in
   * name throws engine_config_error. A factory may return an adapter of any
   * kind, and receives the same-named entry from `providers` as its init.
   * Registration is construction-time only; there is no runtime
   * (post-construction) registration.
   */
  custom_providers?: Record<string, ProviderFactory>
  pricing?: PricingTable
  default_retry?: RetryPolicy
  default_effort?: EffortLevel
  default_max_steps?: number
  defaults?: EngineDefaults
}

export type Engine = {
  generate: <t = string>(opts: GenerateOptions<t>) => Promise<GenerateResult<t>>
  register_price: (provider: string, model_id: string, pricing: Pricing) => void
  resolve_price: (provider: string, model_id: string) => Pricing | undefined
  list_prices: () => PricingTable
  dispose: () => Promise<void>
}
