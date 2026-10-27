/**
 * Public type surface for the AI engine layer.
 *
 * Type aliases and interfaces use PascalCase, per the naming convention.
 * Value-level field names remain snake_case.
 *
 * Shared runtime types (TrajectoryLogger, TrajectoryEvent, RunContext) live in
 * core. The engine imports them via `import type` only; `errors.ts` holds the
 * single exception, the one value import from core that engine source makes.
 */

import type { ToolSchema } from '#schema'
import type { TrajectoryLogger } from '#core'
import type { ClaudeCliProviderConfig } from './providers/claude_cli/types.js'
import type { ProviderFactory, ProviderTransport } from './providers/types.js'

export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Prompt caching for a call: `'off'` asks for none, `'5m'` for a five-minute
 * cache, and `'1h'` for a one-hour one. What a provider does with it depends
 * on the caching its adapter declares; see `docs/providers.md`'s Prompt
 * Caching.
 */
export type CacheSetting = 'off' | '5m' | '1h'

/**
 * What a call records of the requests it sends and the replies it gets:
 * `'off'` records neither, `'turns'` records each turn's request (the
 * first turn whole, a later one as what it changed) on `request_sent` and
 * the reply on `response_received`, and `'wire'` records all that and, on a
 * native transport, the exact body each attempt sends, as `request_wire`.
 * See `docs/concepts.md`'s What Gets Recorded.
 */
export type CaptureLevel = 'off' | 'turns' | 'wire'

/**
 * One captured payload, as `EngineConfig.redact_capture` receives it before
 * the trajectory does: `'request'` is what a turn's `request_sent` would
 * carry as `request`, `'response'` what its `response_received` would carry
 * as `content`, and `'wire'` is `{ url, body }`, what a native adapter is
 * about to send, whose `request_wire` records the `url` and `body` of the
 * object the redactor returns. `data` is a fresh JSON-safe copy, so a
 * redactor may change it in place without touching what goes out, and an
 * image in it is already its base64 text.
 */
export type CapturePayload = {
  readonly kind: 'request' | 'response' | 'wire'
  readonly step_index: number
  readonly data: unknown
}

export type FinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
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
  /**
   * The rate for a one-hour cache write. Unset, a one-hour write costs twice
   * `input_per_million`, which is Anthropic's rate.
   */
  cache_write_1h_per_million?: number
  reasoning_per_million?: number
}

export type PricingTable = Readonly<Record<string, Pricing>>

export type UsageTotals = {
  input_tokens: number
  output_tokens: number
  reasoning_tokens?: number
  cached_input_tokens?: number
  cache_write_tokens?: number
  /**
   * The part of `cache_write_tokens` written with a one-hour lifetime, when
   * the provider reports the split.
   */
  cache_write_1h_tokens?: number
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

/**
 * Wall-clock timing of one step's provider round-trip, measured by the engine
 * around the successful turn attempt: failed attempts and retry backoff are
 * excluded, as is tool execution (that is ToolCallRecord.duration_ms).
 * `first_chunk_ms` is present on every turn that dispatched a chunk:
 * milliseconds from the attempt start to the first StreamChunk the turn
 * dispatched (a token, a reasoning delta, or a tool-call part, never the
 * transport's stream-open framing). Every depth-1 turn streams, consumer or
 * not (an ai_sdk turn always, a native one whenever its adapter supports
 * streaming), so it carries one, while a whole-body turn from a native
 * adapter that doesn't stream has none. `duration_ms - first_chunk_ms` is the window the model spent
 * emitting output, as long as the turn streams output while it generates it.
 * A provider that sends a tool call whole once it has generated it leaves
 * that window at the turn's last few milliseconds. `whole_tool_call` marks
 * such a turn, and `throughput()`, the derived tokens-per-second view,
 * prefers a decode time the provider reports itself, and counts a marked
 * turn's whole round trip when there's none.
 */
export type StepTiming = {
  /** Epoch ms when the successful provider attempt started. */
  started_at: number
  /** Wall-clock ms from attempt start to the turn result. */
  duration_ms: number
  /** Turns that dispatched a chunk: ms from attempt start to the first one. */
  first_chunk_ms?: number
  /**
   * Present when the first chunk belonged to a tool call that arrived whole,
   * its input in one delta or none, so the model generated it before the
   * stamp and the window after `first_chunk_ms` isn't decode time.
   */
  whole_tool_call?: true
}

/**
 * Wall-clock timing of a whole generate call, stamped by the engine around
 * every adapter, external ones included. The window covers everything the
 * call did: every turn, tool execution between turns, turn retries the engine
 * absorbed along with their backoff, and schema repair. StepTiming is the
 * narrower view of one turn's provider round-trip.
 */
export type GenerateTiming = {
  /** Epoch ms when the generate call started. */
  started_at: number
  /** Wall-clock ms from the call's start to its result. */
  duration_ms: number
}

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
  /**
   * Present on every step the engine's tool loop produced (both transports)
   * and on claude_cli steps, whose timing is blended (see ClaudeCliProviderReported).
   * Absent on steps built by other external adapters and on injected test
   * seams that return a TurnResult without one.
   */
  timing?: StepTiming
  finish_reason: FinishReason
  /**
   * This turn's provider-reported detail, keyed by provider name. See
   * TurnResult.provider_reported; a multi-step call keeps every turn's payload
   * here, since the call-level field can only carry one.
   */
  provider_reported?: Record<string, unknown>
}

/**
 * Provider-specific data on a content part, keyed by provider name: the AI
 * SDK's own `providerOptions` shape, and the shape the call-level
 * `provider_options` takes too.
 */
export type ProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>

/**
 * A part's `provider_options` reaches the AI SDK as that part's
 * `providerOptions`, keyed by provider name like the call-level field. It is
 * the only way to reach per-part provider features such as Bedrock's guard
 * content (`{ bedrock: { guardContent: true } }`), which scopes a guardrail's
 * input check to the marked part. Only the ai_sdk transport reads it; native
 * transports and claude_cli ignore it.
 */
export type UserContentPart =
  | { type: 'text'; text: string; provider_options?: ProviderOptions }
  | {
      type: 'image'
      image: Uint8Array | string
      media_type?: string
      provider_options?: ProviderOptions
    }

/**
 * An assistant turn's parts, in the order the provider sent them. A part's
 * `provider_options` holds the data its provider wants back on the next
 * request (a thinking block's signature, Gemini's thought signature on a tool
 * call), keyed by provider name. Each adapter sends back only the reasoning
 * parts carrying its own key, so a `fallback` never hands one vendor's
 * signature to another. An `opaque` part is a block that only its provider
 * understands (a server tool's call or result, say), carried back verbatim
 * under that provider's key and skipped by every other adapter.
 */
export type AssistantContentPart =
  | { type: 'text'; text: string; provider_options?: ProviderOptions }
  | {
      type: 'tool_call'
      id: string
      name: string
      input: unknown
      provider_options?: ProviderOptions
    }
  | {
      type: 'reasoning'
      /** The thinking the model showed, or '' when it showed none (encrypted, redacted, or omitted). */
      text: string
      provider_options?: ProviderOptions
    }
  | {
      type: 'opaque'
      /** The block as its provider sent it, under that provider's key (`{ anthropic: { block } }`). */
      provider_options: ProviderOptions
    }

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | UserContentPart[] }
  | { role: 'assistant'; content: string | AssistantContentPart[] }
  | {
      role: 'tool'
      tool_call_id: string
      name: string
      content: string
      /**
       * True when the call failed (an unknown tool, invalid input, a denied
       * approval, or a thrown error) and `content` is its `{"error": "…"}`
       * text; absent on a success. The native Anthropic transport sends it as
       * the `tool_result`'s `is_error`, and the ai_sdk transport as an
       * `error-text` output; the other wire formats have no such field.
       */
      is_error?: boolean
    }

export type ToolExecContext = {
  abort: AbortSignal
  trajectory?: TrajectoryLogger
  tool_call_id: string
  step_index: number
}

export type Tool<i = unknown, o = unknown> = {
  name: string
  description: string
  input_schema: ToolSchema<i>
  execute: (input: i, ctx: ToolExecContext) => Promise<o> | o
  needs_approval?: boolean | ((input: i) => boolean | Promise<boolean>)
  /**
   * When true, a SUCCESSFUL execution of this tool ends the tool loop
   * deterministically: the loop executes the call (recording its output and
   * trajectory events like any tool), then stops instead of running another
   * model turn. A denied, invalid, dropped, or throwing terminal call does NOT
   * end the loop. undefined (the default) never ends the loop early.
   */
  ends_turn?: boolean
  /**
   * True for a tool whose calls change nothing, such as a file read or a
   * search. A call to it doesn't count toward `max_tool_calls_per_step`,
   * which is there to stop a turn from making calls that depend on each
   * other's effects before the model has seen a result, and a call that
   * changes nothing can't. undefined (the default) counts like any call.
   */
  read_only?: boolean
}

export type ToolApprovalRequest = {
  tool_name: string
  input: unknown
  step_index: number
  /**
   * The id of the call awaiting approval: the same id its stream chunks,
   * ToolExecContext.tool_call_id, and the tool_approval_* trajectory events
   * carry, so a handler can point at a call a UI already shows.
   */
  tool_call_id: string
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
 * Neutral single-turn result shared by every transport (`ai_sdk`,
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
  /**
   * The turn's parts in the order the provider sent them, with the data it
   * wants back. An adapter sets it only when the turn has a reasoning part or
   * a part carrying provider data, and leaves it out otherwise, so every
   * other turn stays as it was. The tool loop builds the assistant message
   * from it when present; `text` and `tool_calls` stay the fields everything
   * else reads.
   */
  readonly content?: ReadonlyArray<AssistantContentPart>
  /**
   * True when the provider paused the turn partway through its response
   * (Anthropic's `pause_turn`, which a long server-tool turn can hit), with
   * `finish_reason` left at `'stop'`. The loop sends the turn back as it is
   * and asks for another turn to continue it. Absent on every other turn.
   */
  readonly paused?: boolean
  /**
   * What the provider says this turn cost, in US dollars, for a provider that
   * reports its charge on the response (OpenRouter does). The loop records it
   * in place of a pricing-table estimate, since it is what was charged. Absent
   * when the provider reported no cost.
   */
  readonly reported_cost_usd?: number
  /**
   * Stamped by the engine's retry wrapper around the successful attempt, not
   * by adapters: an adapter-returned TurnResult never carries one, and the
   * wrapper's value would overwrite it if it did. See StepTiming.
   */
  readonly timing?: StepTiming
  /**
   * Opaque detail the provider reported about this turn, keyed by provider
   * name: Bedrock's guardrail trace, Anthropic's cache breakdown, whatever a
   * given provider volunteers beyond text/usage/finish_reason. The keys are the
   * provider's own, so a caller narrows `provider_reported['bedrock']` at its
   * use site rather than the engine modelling every payload.
   *
   * Absent when the provider reported nothing, never an empty object. The loop
   * copies it onto the step record and generate folds it into
   * GenerateResult.provider_reported.
   */
  readonly provider_reported?: Record<string, unknown>
}

/**
 * One turn's resolved request handed to a native adapter's invoke_turn.
 * generate.ts assembles it from GenerateOptions plus engine defaults (resolved
 * system, effort, merged provider_options, sampling params). When `stream` is
 * true `dispatch_chunk` is defined and the adapter MUST emit StreamChunks
 * through it while still returning the fully aggregated TurnResult. The
 * engine sets `stream` on every turn to an adapter that supports streaming,
 * whether or not the caller passed `on_chunk`, and passes the chunks on only
 * to a consumer.
 */
export type TurnRequest = {
  readonly step_index: number
  readonly messages: ReadonlyArray<Message>
  readonly tools: ReadonlyArray<Tool>
  readonly abort: AbortSignal
  readonly stream: boolean
  readonly model_id: string
  readonly system?: string
  readonly schema?: ToolSchema
  readonly effort: EffortLevel
  readonly provider_options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly temperature?: number
  readonly max_tokens?: number
  readonly top_p?: number
  /**
   * The cache lifetime the engine resolved for this call, absent when caching
   * is off. An adapter that declares `prompt_cache` maps it onto its wire.
   */
  readonly cache?: Exclude<CacheSetting, 'off'>
  readonly dispatch_chunk?: (chunk: StreamChunk) => Promise<void>
  /**
   * Present when the call captures at `'wire'`. An adapter that builds an
   * HTTP body calls it with the URL and the body object just before it
   * serializes the body, once per attempt, and never with a header.
   */
  readonly on_wire?: (wire: { readonly url: string; readonly body: Record<string, unknown> }) => void
}

/**
 * Context handed to a prepare_step hook: the turn's index and the would-be
 * request messages (the full accumulated transcript at that point in the
 * loop). Kept minimal by design; per-step model/effort switching is out of
 * scope.
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
 * Per-turn message hook. run_tool_loop calls it before each turn on every
 * transport. Returning replacement messages reshapes ONLY what is sent
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
  schema?: ToolSchema<t>
  tools?: Tool[]
  effort?: EffortLevel
  temperature?: number
  max_tokens?: number
  top_p?: number
  max_steps?: number
  /**
   * Per-turn wall-clock budget in milliseconds. When set, the engine composes
   * a timeout signal with `abort` around every turn; an expiry throws a
   * retryable timeout, unless a chunk has already reached `on_chunk`, in which
   * case it becomes a non-retryable stream interruption. undefined (the
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
   * Cap on tool calls executed per step. A call to a tool flagged
   * `read_only` doesn't count. The first call past the cap, and every call
   * after it, are dropped for that step and surfaced via ToolCallRecord
   * errors and a tool_calls_dropped trajectory event. When the loop goes on,
   * one user message after the step's tool results names them, so the model
   * can make them again. undefined (the default) leaves the count unlimited.
   */
  max_tool_calls_per_step?: number
  on_tool_approval?: ToolApprovalHandler
  /**
   * Per-turn hook to reshape the messages sent to the model without mutating
   * the canonical transcript. Called before every turn with the step
   * index and the would-be request messages; return `{ messages }` to
   * prune/replace that turn's request or undefined for a no-op. A
   * `step_prepared` trajectory event records every turn it replaced. See
   * PrepareStepHook.
   */
  prepare_step?: PrepareStepHook
  /**
   * Prompt caching for this call. Left unset, an adapter that caches with
   * tools (Anthropic, on either transport) caches for five minutes when the
   * call has tools, and every other adapter asks for no cache. `'off'` turns it off. An
   * adapter that can't honor an explicit `'5m'` or `'1h'` records
   * `option_ignored`. Any other value throws `engine_config_error`.
   */
  cache?: CacheSetting
  /**
   * What this call records of each turn's request and reply. Left unset,
   * the engine's `defaults.capture` applies, and with neither set nothing is
   * recorded. A captured request carries user data, so keep it off where
   * the trajectory goes somewhere that data mustn't. Any other value throws
   * `engine_config_error`. See CaptureLevel.
   */
  capture?: CaptureLevel
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
  /**
   * Provider-keyed detail for the call, taken from the last step that reported
   * any: provider payloads are opaque, so they cannot be summed the way usage
   * and cost are. Mirrors `content` and `finish_reason` in reflecting the final
   * turn; `steps[i].provider_reported` holds every turn's own payload.
   */
  provider_reported?: Record<string, unknown>
  /**
   * The whole call's wall clock, stamped by the engine for every adapter.
   * Absent only on a result that never passed through an engine's
   * `generate`, such as one a `fascicle/testing` stub engine returns.
   */
  timing?: GenerateTiming
}

export type ProviderInit = {
  api_key?: string
  base_url?: string
  [k: string]: unknown
}

/**
 * AWS credentials as `@ai-sdk/amazon-bedrock`'s `credentialProvider` seam
 * expects them. The SDK supplies `region` itself, calls the provider once per
 * request, and never passes arguments, so a provider that caches and refreshes
 * (as `fromNodeProviderChain()` does) is the norm rather than the exception.
 */
export type BedrockCredentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export type BedrockCredentialProvider = () => PromiseLike<BedrockCredentials>

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
    use_credential_chain?: boolean
    credential_provider?: BedrockCredentialProvider
  }
  claude_cli?: ClaudeCliProviderConfig
  [custom: string]: ProviderInit | undefined
}

/**
 * Opt-in OpenTelemetry for the `ai_sdk` transport (Layer 2). When `enabled`,
 * the transport constructs an `@ai-sdk/otel` integration strictly below the turn
 * seam and hands it to the SDK's telemetry, so streamText, which every turn
 * takes, emits turn-internal spans on the ai_sdk transport only. Native transports ignore it;
 * loop-level, transport-neutral tracing is the `fascicle/otel` bridge's job
 * (Layer 1). `tracer` is an `@opentelemetry/api` Tracer, typed `unknown` here so
 * the engine's public type surface stays free of the optional OTel peer.
 */
export type AiSdkTelemetrySettings = {
  readonly enabled: boolean
  readonly function_id?: string
  readonly record_inputs?: boolean
  readonly record_outputs?: boolean
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
  readonly tracer?: unknown
}

/**
 * Call-level defaults applied by the engine before dispatching to a provider.
 *
 * Per-call options from `generate(opts)` win over defaults using these rules:
 *
 * | Field                                                                 | Rule                                      |
 * | --------------------------------------------------------------------- | ----------------------------------------- |
 * | `model`                                                               | per-call wins; else default; else model_required_error is thrown |
 * | `provider`                                                            | per-call wins; else default; else sole configured provider; else provider_required_error is thrown |
 * | `system`, `effort`, `cache`, `capture`, `max_steps`, `turn_timeout_ms`, `tool_error_policy`, `schema_repair_attempts`, `tool_call_repair_attempts`, `max_tool_calls_per_step` | per-call wins (nullish coalesce) |
 * | `temperature`, `max_tokens`, `top_p`                                  | per-call wins (nullish coalesce)          |
 * | `retry_policy`                                                        | per-call replaces wholesale                |
 * | `provider_options`                                                    | two-level: per-provider-key shallow merge  |
 * | `prompt`, `tools`, `schema`, `abort`, `trajectory`, `on_chunk`        | not defaultable; always call-supplied      |
 */
export type EngineDefaults = {
  readonly model?: string
  readonly provider?: string
  readonly system?: string
  readonly effort?: EffortLevel
  /**
   * Prompt caching for every call that sets none. An unknown value throws
   * `engine_config_error` at `create_engine`. See `GenerateOptions.cache`.
   */
  readonly cache?: CacheSetting
  /**
   * What every call that sets none records of its requests and replies. An
   * unknown value throws `engine_config_error` at `create_engine`. See
   * `GenerateOptions.capture`.
   */
  readonly capture?: CaptureLevel
  readonly temperature?: number
  readonly max_tokens?: number
  readonly top_p?: number
  readonly max_steps?: number
  readonly turn_timeout_ms?: number
  readonly retry_policy?: RetryPolicy
  readonly tool_error_policy?: 'feed_back' | 'throw'
  readonly schema_repair_attempts?: number
  readonly tool_call_repair_attempts?: number
  readonly max_tool_calls_per_step?: number
  readonly provider_options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /**
   * Opt-in OpenTelemetry for the `ai_sdk` transport (Layer 2). Enabling it
   * makes every ai_sdk-transport generate call emit turn-internal spans via
   * `@ai-sdk/otel`; native transports ignore it. See AiSdkTelemetrySettings.
   */
  readonly ai_sdk_telemetry?: AiSdkTelemetrySettings
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
  /**
   * Scrub or drop each captured payload before the trajectory records it,
   * for every call on this engine. It returns what to record in the
   * payload's place, and `undefined` records nothing. A redactor that
   * throws, or that returns a promise or any other thenable, records
   * nothing either, and the turn records `capture_redaction_failed` naming
   * the payload's kind, so nothing that it would have scrubbed is written. It
   * covers only what `capture` adds, never `model_chunk`, `tool_call.input`,
   * `tool_result.output`, or the `raw_text` fields. See CapturePayload.
   */
  redact_capture?: (payload: CapturePayload) => unknown
}

export type Engine = {
  generate: <t = string>(opts: GenerateOptions<t>) => Promise<GenerateResult<t>>
  register_price: (provider: string, model_id: string, pricing: Pricing) => void
  resolve_price: (provider: string, model_id: string) => Pricing | undefined
  list_prices: () => PricingTable
  /**
   * Derive a NEW engine with additional or overriding providers: the
   * value-semantic answer to "register a provider after construction", not
   * mutable runtime registration. `providers` shallow-merge by name over this
   * engine's configured providers (a same-named entry overrides), and
   * `custom_providers` likewise over the configured custom registry; every
   * other setting (construction-time pricing, defaults, retry) carries forward
   * unchanged. The merged config is re-validated under the same custom-first
   * resolution and built-in shadow-throws rule, all adapters are constructed
   * fresh, and the derived engine disposes independently. This engine is left
   * untouched: it keeps its own adapters, dispose lifecycle, and any runtime
   * `register_price` mutations.
   */
  with_providers: (
    providers: ProviderConfigMap,
    custom_providers?: Record<string, ProviderFactory>,
  ) => Engine
  dispose: () => Promise<void>
}
