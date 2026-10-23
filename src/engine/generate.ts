/**
 * `generate(opts)`: the single public entry point for model calls.
 *
 * This file is SDK-agnostic: it resolves options, gates capabilities, and
 * owns retry and trajectory recording, and it drives every turn
 * (both the `ai_sdk` and native transports) through the neutral
 * `invoke_turn` seam. The Vercel AI SDK call itself lives in
 * providers/ai_sdk/invoke.ts, the only module allowed to import from `ai`
 * (enforced by the no-ai-import-outside-ai-sdk-provider rule). tool_loop.ts
 * consumes the InvokeOnce seam built here.
 *
 * That seam is reached by `await import(...)` rather than a static import, and
 * the types it exports come in type-only (erased at compile time), so `ai`
 * enters the module graph only on a call that actually selects the ai_sdk
 * transport. A native-transport or claude_cli user never loads it.
 */

import type {
  AiSdkTelemetrySettings,
  CacheSetting,
  CaptureLevel,
  CapturePayload,
  CostBreakdown,
  EffortLevel,
  FinishReason,
  GenerateOptions,
  GenerateResult,
  GenerateTiming,
  Message,
  Pricing,
  PricingTable,
  ResolvedModel,
  RetryPolicy,
  StepTiming,
  StreamChunk,
  Tool,
  TurnRequest,
  TurnResult,
} from './types.js'
import {
  aborted_error,
  engine_config_error,
  incomplete_generation_error,
  model_required_error,
  on_chunk_error,
  provider_capability_error,
  provider_error,
  provider_not_configured_error,
  provider_required_error,
  turn_timeout_error,
} from './errors.js'
import { format_schema_issues, to_json_schema } from '#schema'
import type { ToolSchema } from '#schema'
import type { TrajectoryLogger } from '#core'
import { split_leading_system_run } from './leading_system.js'
import { merge_provider_options } from './merge_defaults.js'
import { FREE_PROVIDERS, pricing_key, round6 } from './pricing.js'
import { parse_retry_after, retry_with_policy } from './retry.js'
import {
  build_repair_message,
  parse_with_schema,
  throw_schema_validation,
} from './schema.js'
import {
  create_chunk_dispatcher,
  type ChunkDispatcher,
} from './streaming.js'
import {
  create_option_ignored_dedup,
  create_pricing_missing_dedup,
  end_generate_span,
  record_effort_ignored,
  record_schema_validation_failed,
  record_turn_retry,
  start_generate_span,
  with_timestamps,
} from './trajectory.js'
import { sum_usage } from './usage.js'
import {
  json_schema_or_undefined,
  run_tool_loop,
  type InvokeOnce,
  type InvokeOnceArgs,
  type LoopCapture,
  type ToolLoopConfig,
} from './tool_loop.js'
import { missing_peer_error } from './providers/types.js'
import type {
  AiSdkProviderAdapter,
  NativeProviderAdapter,
  ProviderAdapter,
} from './providers/types.js'
import type { AiSdkTurn, AiSdkTurnConfig } from './providers/ai_sdk/invoke.js'

export type EngineInternals = {
  readonly pricing: PricingTable
  readonly adapters: ReadonlyMap<string, ProviderAdapter>
  readonly default_retry: RetryPolicy
  readonly default_effort: EffortLevel
  readonly default_cache?: CacheSetting
  readonly default_capture?: CaptureLevel
  readonly default_max_steps: number
  readonly default_turn_timeout_ms?: number
  readonly default_ai_sdk_telemetry?: AiSdkTelemetrySettings
  readonly default_model?: string
  readonly default_provider?: string
  readonly default_system?: string
  readonly default_temperature?: number
  readonly default_max_tokens?: number
  readonly default_top_p?: number
  readonly default_tool_error_policy?: 'feed_back' | 'throw'
  readonly default_schema_repair_attempts?: number
  readonly default_tool_call_repair_attempts?: number
  readonly default_max_tool_calls_per_step?: number
  readonly default_provider_options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly redact_capture?: ((payload: CapturePayload) => unknown) | undefined
}

/**
 * Build the initial message list for a generate call from `opts.system` and
 * `opts.prompt`.
 *
 * A non-empty string `system` is prepended as a system message. A string
 * `prompt` becomes a single user message; a `Message[]` prompt is copied
 * through element-by-element so the returned array can be mutated without
 * affecting the caller's.
 */
export function build_initial_messages<T>(opts: GenerateOptions<T>): Message[] {
  const messages: Message[] = []
  if (typeof opts.system === 'string' && opts.system.length > 0) {
    messages.push({ role: 'system', content: opts.system })
  }
  if (typeof opts.prompt === 'string') {
    messages.push({ role: 'user', content: opts.prompt })
    return messages
  }
  for (const m of opts.prompt) messages.push({ ...m })
  return messages
}

/**
 * The engine-Message analog of the SDK-side split_leading_system
 * (providers/ai_sdk/invoke.ts): build_native_invoke hoists the leading system
 * run into TurnRequest.system so a native adapter maps conversation messages
 * only. Same guards as the SDK variant: only the leading run is hoisted, and
 * the original list is returned untouched when hoisting would leave `messages`
 * empty (provider APIs reject an empty messages array).
 */
export function split_leading_system_messages(messages: ReadonlyArray<Message>): {
  system?: string
  messages: Message[]
} {
  return split_leading_system_run(messages, (m) => m.content)
}

const RETRY_CLASSIFIED_KINDS = new Set(['rate_limit', 'provider_5xx', 'network', 'timeout'])
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])

/**
 * True when `err` already carries a `kind` this layer treats as retryable, so
 * the classifier passes it through untouched.
 */
function has_retry_kind(err: object): boolean {
  const kind = Reflect.get(err, 'kind')
  return typeof kind === 'string' && RETRY_CLASSIFIED_KINDS.has(kind)
}

/**
 * Read the HTTP status off either `statusCode` or `status`, in that order.
 */
function resolve_error_status(err: object): number | undefined {
  const status = Reflect.get(err, 'statusCode')
  if (typeof status === 'number') return status
  const status_alt = Reflect.get(err, 'status')
  return typeof status_alt === 'number' ? status_alt : undefined
}

/**
 * Copy the error's `message` onto a classification record when it is a string,
 * returning the same record for chaining.
 */
function with_error_message(
  err: object,
  out: Record<string, unknown>,
): Record<string, unknown> {
  const message = Reflect.get(err, 'message')
  if (typeof message === 'string') out['message'] = message
  return out
}

/**
 * Parse a `Retry-After` value off the error's `responseHeaders`, if present.
 */
function retry_after_from_error(err: object): number | undefined {
  const headers = Reflect.get(err, 'responseHeaders')
  if (headers === null || typeof headers !== 'object') return undefined
  const hv = Reflect.get(headers, 'retry-after')
  return typeof hv === 'string' ? parse_retry_after(hv) : undefined
}

/**
 * Build the classification for a retryable status (`rate_limit` for a 429,
 * `provider_5xx` for a 5xx), attaching the message and a parsed `Retry-After`
 * when either is present. HTTP defines the header for a 503 as well as a 429,
 * so a server's wait counts on both.
 */
function classify_status(
  err: object,
  kind: 'rate_limit' | 'provider_5xx',
  status: number,
): Record<string, unknown> {
  const out = with_error_message(err, { kind, status })
  const retry_after_ms = retry_after_from_error(err)
  if (retry_after_ms !== undefined) out['retry_after_ms'] = retry_after_ms
  return out
}

/**
 * True when `value` carries a `code` that names a known network failure.
 */
function has_network_code(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const code = Reflect.get(value, 'code')
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code)
}

/**
 * Build the `network` classification when the error or its `cause` carries a
 * known network error code, or `undefined` when neither does. The AI SDK
 * wraps a failed fetch in an `APICallError` whose `cause` holds undici's code.
 */
function classify_network_error(err: object): Record<string, unknown> | undefined {
  if (!has_network_code(err) && !has_network_code(Reflect.get(err, 'cause'))) return undefined
  return with_error_message(err, { kind: 'network' })
}

/**
 * Classify a thrown provider error into the shape `retry_with_policy`
 * understands.
 *
 * Passes through anything that already carries a recognized `kind`.
 * Otherwise inspects `statusCode`/`status`: 429 becomes `rate_limit` and 5xx
 * becomes `provider_5xx`, each reading `Retry-After` off `responseHeaders`
 * when present, and a known network error code (`ECONNRESET`, `ETIMEDOUT`,
 * `ENOTFOUND`, `ECONNREFUSED`, or undici's `UND_ERR_HEADERS_TIMEOUT`,
 * `UND_ERR_BODY_TIMEOUT`, and `UND_ERR_SOCKET`), on the error or on its
 * `cause`, becomes `network`. Anything else passes through unclassified,
 * which `retry_with_policy` treats as non-retryable.
 */
export function classify_provider_error(err: unknown): unknown {
  if (err === null || typeof err !== 'object') return err
  if (has_retry_kind(err)) return err
  const status = resolve_error_status(err)
  if (status === 429) return classify_status(err, 'rate_limit', status)
  if (status !== undefined && status >= 500 && status < 600) {
    return classify_status(err, 'provider_5xx', status)
  }
  return classify_network_error(err) ?? err
}

type AiSdkInvokeConfig = {
  readonly invoke_turn: AiSdkTurn
  readonly retry_policy: RetryPolicy
  readonly turn_timeout_ms: number | undefined
  readonly trajectory: TrajectoryLogger | undefined
  readonly on_chunk_provided: boolean
}

type NativeInvokeConfig = {
  readonly adapter: NativeProviderAdapter
  readonly model_id: string
  readonly retry_policy: RetryPolicy
  readonly turn_timeout_ms: number | undefined
  readonly trajectory: TrajectoryLogger | undefined
  readonly dispatcher: ChunkDispatcher
  readonly effort: EffortLevel
  readonly cache: CacheSetting
  readonly schema: TurnRequest['schema']
  readonly provider_options: TurnRequest['provider_options']
  readonly temperature: number | undefined
  readonly max_tokens: number | undefined
  readonly top_p: number | undefined
  readonly on_chunk_provided: boolean
}

type TurnDeadline = {
  readonly signal: AbortSignal
  readonly timed_out: () => boolean
  readonly dispose: () => void
}

/**
 * Compose the per-attempt turn signal: the user's abort OR'd with a fresh
 * `turn_timeout_ms` deadline via `AbortSignal.any` (the same pattern
 * `src/core/timeout.ts` uses). `timed_out()` distinguishes an expiry
 * (retryable) from a user abort (terminal) in the `retry_turn` ladder;
 * `dispose()` clears the timer so a settled attempt never leaves one armed.
 * With no budget configured, the user's abort signal passes through
 * unchanged. Armed fresh inside `retry_with_policy`'s callback so each retry
 * gets its own full budget rather than sharing one deadline across attempts.
 */
function arm_turn_timeout(
  user_abort: AbortSignal,
  turn_timeout_ms: number | undefined,
): TurnDeadline {
  if (turn_timeout_ms === undefined) {
    // Stryker disable next-line ArrowFunction: timed_out is only ever read as `if (deadline.timed_out())`, where () => undefined and () => false are both falsy, so the mutant is behaviorally identical.
    return { signal: user_abort, timed_out: () => false, dispose: () => {} }
  }
  const local = new AbortController()
  const composed = AbortSignal.any([user_abort, local.signal])
  let timed_out = false
  const timer = setTimeout(() => {
    timed_out = true
    local.abort()
  }, turn_timeout_ms)
  return {
    signal: composed,
    timed_out: () => timed_out,
    dispose: () => {
      clearTimeout(timer)
    },
  }
}

/**
 * Engine-owned wrapper shared by both transports: one turn attempt inside
 * retry_with_policy. The catch ladder classifies by CAUSE, not
 * by the shape the transport happened to throw: on_chunk_error passes through,
 * then a genuine user abort wins, then any error once a chunk has reached a
 * consumer is a non-retryable stream interruption, then a `turn_timeout_ms`
 * expiry is a retryable typed timeout, and only a below-loop aborted_error
 * unrelated to either passes through. With no consumer attached, nothing was
 * delivered that a retry would repeat, so a mid-stream failure, a deadline
 * expiry included, is classified as one before any chunk is. Cause-first
 * ordering is what keeps the two transports in parity: the ai_sdk transport
 * reports a mid-stream abort as an aborted_error and the native one as a raw
 * AbortError, so both must be read as the same interruption rather than the
 * ai_sdk timeout masquerading as a user cancel. call_once receives the
 * composed abort+timeout signal so the deadline actually cancels the
 * in-flight request. Adapters may swap `classify`, but never the ladder
 * itself: the engine owns retry, so a hidden adapter-level retry would be
 * invisible to anything relying on this ladder.
 *
 * The wrapper also stamps StepTiming here, and only here, because this is the
 * one place that can see attempt boundaries: started_at re-stamps at every
 * attempt entry, so failed attempts and backoff waits never inflate
 * duration_ms. `first_chunk_at` (the builder's Date.now() from its first
 * dispatched chunk) belongs to the returning attempt, since the builder
 * clears it as each attempt starts.
 */
function retry_turn(
  call_once: (turn_abort: AbortSignal) => Promise<TurnResult>,
  args: InvokeOnceArgs,
  first_chunk_at: () => number | undefined,
  retry_policy: RetryPolicy,
  classify: (err: unknown) => unknown,
  turn_timeout_ms: number | undefined,
  trajectory: TrajectoryLogger | undefined,
  on_chunk_provided: boolean,
): Promise<TurnResult> {
  const has_streamed = (): boolean => on_chunk_provided && first_chunk_at() !== undefined
  return retry_with_policy(
    async () => {
      const started_at = Date.now()
      const deadline = arm_turn_timeout(args.abort, turn_timeout_ms)
      try {
        const turn = await call_once(deadline.signal)
        return { ...turn, timing: build_step_timing(started_at, first_chunk_at()) }
      } catch (err: unknown) {
        if (err instanceof on_chunk_error) throw err
        // A genuine user abort wins over everything below it, including a
        // deadline that fired in the same tick, so an intentional cancel
        // always surfaces as aborted_error.
        if (args.abort.aborted) {
          throw new aborted_error('aborted', {
            reason: args.abort.reason,
            step_index: args.step_index,
          })
        }
        // Any failure once a chunk has reached a consumer is a non-retryable
        // stream interruption, a deadline expiry included (a retry would
        // re-emit output the consumer already saw). Checked before the
        // aborted_error pass-through so a mid-stream ai_sdk abort classifies
        // here, in parity with the native transport's raw AbortError.
        if (has_streamed()) {
          const message = err instanceof Error ? err.message : String(err)
          throw new provider_error(`stream interrupted: ${message}`, {
            cause_kind: 'unknown',
          })
        }
        // A deadline expiry that no consumer saw output from is a retryable
        // typed timeout, whatever shape the transport threw when its signal
        // aborted. turn_timeout_ms is defined whenever timed_out() can be true.
        if (deadline.timed_out()) {
          throw new turn_timeout_error(turn_timeout_ms ?? 0, args.step_index)
        }
        // A below-loop aborted_error not attributable to the user or the
        // deadline passes through unclassified.
        if (err instanceof aborted_error) throw err
        throw classify(err)
      } finally {
        deadline.dispose()
      }
    },
    retry_policy,
    args.abort,
    (info) => {
      record_turn_retry(trajectory, args.step_index, info, args.step_span)
    },
  )
}

/**
 * Assemble one turn's StepTiming from the attempt's start stamp and the
 * builder's first-chunk stamp (undefined on non-streamed turns).
 */
function build_step_timing(
  started_at: number,
  first_chunk: number | undefined,
): StepTiming {
  const timing: StepTiming = { started_at, duration_ms: Date.now() - started_at }
  if (first_chunk !== undefined) timing.first_chunk_ms = first_chunk - started_at
  return timing
}

/**
 * Build the ai_sdk-transport InvokeOnce: the SDK turn built by
 * providers/ai_sdk/invoke.ts behind the same engine-owned retry_turn wrapper
 * the native path uses. The SDK call body lives behind the seam, and every
 * turn streams; this builder owns only retry and the first-chunk stamp, which
 * it clears as each attempt starts, and which both makes a failure after a
 * chunk reached a consumer a non-retryable interruption and doubles as
 * StepTiming.first_chunk_ms.
 */
function build_ai_sdk_invoke(cfg: AiSdkInvokeConfig): InvokeOnce {
  return async (args: InvokeOnceArgs): Promise<TurnResult> => {
    let first_chunk_at: number | undefined
    const call_once = (turn_abort: AbortSignal): Promise<TurnResult> => {
      first_chunk_at = undefined
      return cfg.invoke_turn({
        step_index: args.step_index,
        messages: args.messages,
        abort: turn_abort,
        on_first_chunk: () => {
          first_chunk_at ??= Date.now()
        },
      })
    }

    return await retry_turn(
      call_once,
      args,
      () => first_chunk_at,
      cfg.retry_policy,
      classify_provider_error,
      cfg.turn_timeout_ms,
      cfg.trajectory,
      cfg.on_chunk_provided,
    )
  }
}

/**
 * Build the native-transport InvokeOnce: maps the loop's InvokeOnceArgs to a
 * TurnRequest and calls adapter.invoke_turn inside the same retry_turn
 * wrapper as the ai_sdk path. Every turn asks for a stream when the adapter
 * supports streaming, whether or not a consumer is attached, so a long turn's
 * headers arrive before fetch's 300-second limit, and the adapter gets a
 * `dispatch_chunk` that stamps the first chunk of each attempt and hands
 * every chunk to the shared dispatcher, which passes it on only to a
 * consumer. The adapter sees a child abort signal so a throwing on_chunk
 * consumer cancels the in-flight request, which is what lets run_tool_loop
 * treat both transports identically.
 */
function build_native_invoke(cfg: NativeInvokeConfig): InvokeOnce {
  const classify = cfg.adapter.classify_error ?? classify_provider_error
  const streams = cfg.adapter.supports('streaming')
  return async (args: InvokeOnceArgs): Promise<TurnResult> => {
    let first_chunk_at: number | undefined
    const call_once = async (turn_abort: AbortSignal): Promise<TurnResult> => {
      first_chunk_at = undefined
      // turn_abort is the composed user-abort + turn_timeout deadline; the
      // internal controller adds one more reason to cancel (a throwing chunk
      // consumer) without losing either of those.
      const internal_controller = new AbortController()
      const cancel_on_turn_abort = (): void => {
        internal_controller.abort(turn_abort.reason)
      }
      // Stryker disable next-line BlockStatement: unreachable pre-abort guard. retry_with_policy re-checks abort.aborted at the top of every attempt and there is no await between that check and this synchronous read, so the composed turn_abort is never already-aborted when call_once begins.
      if (turn_abort.aborted) {
        internal_controller.abort(turn_abort.reason)
      } else {
        // Stryker disable next-line ObjectLiteral,BooleanLiteral: { once: true } is a cleanup optimization only. The abort event is terminal (fires at most once) and the finally below removes the listener, so once:false is unobservable.
        turn_abort.addEventListener('abort', cancel_on_turn_abort, { once: true })
      }
      const dispatch_chunk = async (chunk: StreamChunk): Promise<void> => {
        first_chunk_at ??= Date.now()
        try {
          await cfg.dispatcher.dispatch(chunk)
        } catch (err: unknown) {
          internal_controller.abort()
          throw err
        }
      }
      const { system, messages } = split_leading_system_messages(args.messages)
      const req: TurnRequest = {
        step_index: args.step_index,
        messages,
        tools: args.tools,
        abort: internal_controller.signal,
        stream: streams,
        model_id: cfg.model_id,
        effort: cfg.effort,
        ...(cfg.cache !== 'off' ? { cache: cfg.cache } : {}),
        ...(system !== undefined ? { system } : {}),
        ...(cfg.schema !== undefined ? { schema: cfg.schema } : {}),
        ...(cfg.provider_options !== undefined
          ? { provider_options: cfg.provider_options }
          : {}),
        ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
        ...(cfg.max_tokens !== undefined ? { max_tokens: cfg.max_tokens } : {}),
        ...(cfg.top_p !== undefined ? { top_p: cfg.top_p } : {}),
        ...(streams ? { dispatch_chunk } : {}),
        ...(args.on_wire !== undefined ? { on_wire: args.on_wire } : {}),
      }
      try {
        return await cfg.adapter.invoke_turn(req)
      } finally {
        // The finally is listener cleanup only: with { once: true } the listener
        // self-removes on fire and the composed turn_abort is attempt-scoped, so
        // an emptied finally or an empty event name here leaks nothing
        // observable (the BlockStatement survivor is a documented equivalent).
        // Stryker disable next-line StringLiteral: unobservable cleanup, see above.
        turn_abort.removeEventListener('abort', cancel_on_turn_abort)
      }
    }

    return await retry_turn(
      call_once,
      args,
      () => first_chunk_at,
      cfg.retry_policy,
      classify,
      cfg.turn_timeout_ms,
      cfg.trajectory,
      cfg.on_chunk_provided,
    )
  }
}

/**
 * Throw `engine_config_error` before any request when two or more of a call's
 * tools share a name, naming each duplicate with its count. The loop and
 * every transport key tools by name, so a duplicate would silently replace
 * the tool before it.
 */
function assert_unique_tool_names(tools: ReadonlyArray<Tool> | undefined): void {
  if (tools === undefined) return
  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)
  const duplicates = [...counts].filter(([, count]) => count > 1)
  if (duplicates.length === 0) return
  const listed = duplicates.map(([name, count]) => `${name} (${String(count)})`).join(', ')
  throw new engine_config_error(
    `duplicate tool names: ${listed}; give each tool its own name, or pass \`name_prefix\` to mcp_client for one server's tools`,
  )
}

const CACHE_SETTINGS: Readonly<Record<CacheSetting, true>> = { off: true, '5m': true, '1h': true }
// Stryker disable next-line BooleanLiteral: assert_allowed reads only the keys, through Object.hasOwn, so a value of false allows the same levels.
const CAPTURE_LEVELS: Readonly<Record<CaptureLevel, true>> = { off: true, turns: true, wire: true }

/**
 * Throw `engine_config_error` when `value` is set to anything but a key of
 * `allowed`, naming the field, the value, and the values it takes.
 */
function assert_allowed(
  allowed: Readonly<Record<string, true>>,
  value: string | undefined,
  field: string,
): void {
  if (value === undefined || Object.hasOwn(allowed, value)) return
  const listed = Object.keys(allowed).map((key) => `'${key}'`).join(', ')
  throw new engine_config_error(`${field} must be one of ${listed}, got ${JSON.stringify(value)}`)
}

/**
 * Throw `engine_config_error` for a cache setting that isn't a
 * `CacheSetting`. `create_engine` checks `defaults.cache` with it, and
 * `generate` a call's `cache`.
 */
export function assert_cache_setting(value: string | undefined, field: string): void {
  assert_allowed(CACHE_SETTINGS, value, field)
}

/**
 * Throw `engine_config_error` for a capture level that isn't a
 * `CaptureLevel`. `create_engine` checks `defaults.capture` with it, and
 * `generate` a call's `capture`.
 */
export function assert_capture_level(value: string | undefined, field: string): void {
  assert_allowed(CAPTURE_LEVELS, value, field)
}

/**
 * Resolve the provider name: per-call, then the engine default, then the sole
 * configured adapter. With several providers configured and neither a per-call
 * provider nor a default, there is no sane guess, so this throws
 * provider_required_error naming the configured providers.
 */
function resolve_provider<T>(
  opts_in: GenerateOptions<T>,
  engine: EngineInternals,
): string {
  const sole_provider =
    engine.adapters.size === 1 ? [...engine.adapters.keys()][0] : undefined
  const resolved = opts_in.provider ?? engine.default_provider ?? sole_provider
  if (resolved === undefined) {
    throw new provider_required_error([...engine.adapters.keys()])
  }
  return resolved
}

/**
 * Resolve the model/provider pair for one call and freeze the resolved
 * options view.
 *
 * The model must resolve (per-call, then engine default) or the call cannot
 * proceed. Engine-default system, sampling knobs (temperature, max_tokens,
 * top_p), and provider_options merge under per-call ones here so every
 * transport downstream sees a single already-merged view instead of
 * re-merging per branch.
 */
function resolve_target<T>(
  opts_in: GenerateOptions<T>,
  engine: EngineInternals,
): { opts: GenerateOptions<T>; target: ResolvedModel } {
  const resolved_model = opts_in.model ?? engine.default_model
  if (resolved_model === undefined) throw new model_required_error()
  const resolved_provider = resolve_provider(opts_in, engine)

  const merged_provider_options = merge_provider_options(
    engine.default_provider_options,
    opts_in.provider_options,
  )

  const opts: GenerateOptions<T> = {
    ...opts_in,
    model: resolved_model,
    provider: resolved_provider,
  }
  if (opts_in.system === undefined && engine.default_system !== undefined) {
    opts.system = engine.default_system
  }
  if (opts_in.temperature === undefined && engine.default_temperature !== undefined) {
    opts.temperature = engine.default_temperature
  }
  if (opts_in.max_tokens === undefined && engine.default_max_tokens !== undefined) {
    opts.max_tokens = engine.default_max_tokens
  }
  if (opts_in.top_p === undefined && engine.default_top_p !== undefined) {
    opts.top_p = engine.default_top_p
  }
  if (merged_provider_options !== undefined) {
    opts.provider_options = merged_provider_options
  }
  return {
    opts,
    target: { provider: resolved_provider, model_id: resolved_model },
  }
}

/**
 * Reject a call that uses a capability the resolved adapter does not
 * implement. Checked up front, before any transport work, so the failure is a
 * typed capability error rather than a mid-call provider rejection.
 */
function assert_capabilities<T>(
  adapter: AiSdkProviderAdapter | NativeProviderAdapter,
  provider: string,
  opts: GenerateOptions<T>,
  tools_list: ReadonlyArray<Tool>,
  on_chunk_provided: boolean,
): void {
  if (opts.schema !== undefined && !adapter.supports('schema')) {
    throw new provider_capability_error(provider, 'schema')
  }
  if (tools_list.length > 0 && !adapter.supports('tools')) {
    throw new provider_capability_error(provider, 'tools')
  }
  if (on_chunk_provided && !adapter.supports('streaming')) {
    throw new provider_capability_error(provider, 'streaming')
  }
}

type TurnConfig = {
  readonly effort: EffortLevel
  readonly cache: CacheSetting
  readonly capture: CaptureLevel
  readonly retry_policy: RetryPolicy
  readonly turn_timeout_ms: number | undefined
}

type CallShape = {
  readonly adapter: AiSdkProviderAdapter | NativeProviderAdapter
  readonly tools: ReadonlyArray<Tool>
  readonly trajectory: TrajectoryLogger | undefined
}

type CacheResolution = {
  readonly cache: CacheSetting
  readonly ignored_reason?: string
}

/**
 * Read the caching an adapter declares. An `ai_sdk` adapter that declares
 * `'with_tools'` or `'opt_in'` but has no `translate_cache` has no way to put
 * the setting on the call, so it counts as declaring nothing.
 */
function declared_caching(
  adapter: AiSdkProviderAdapter | NativeProviderAdapter,
): NativeProviderAdapter['prompt_cache'] {
  if (adapter.kind === 'ai_sdk' && adapter.prompt_cache !== 'automatic' && adapter.translate_cache === undefined) {
    return undefined
  }
  return adapter.prompt_cache
}

/**
 * Resolve a call's cache setting from the caching its adapter declares and
 * the setting the call or the engine asked for. `'with_tools'` caches for
 * five minutes by default on a call with tools, `'opt_in'` only when asked,
 * and an `'automatic'` or undeclared adapter never, with a reason for
 * ignoring an explicit `'5m'` or `'1h'`.
 */
function resolve_cache(
  declared: NativeProviderAdapter['prompt_cache'],
  explicit: CacheSetting | undefined,
  has_tools: boolean,
): CacheResolution {
  if (declared === 'with_tools') return { cache: explicit ?? (has_tools ? '5m' : 'off') }
  if (declared === 'opt_in') return { cache: explicit ?? 'off' }
  if (explicit === undefined || explicit === 'off') return { cache: 'off' }
  return {
    cache: 'off',
    ignored_reason:
      declared === 'automatic'
        ? 'the provider caches on its own'
        : "this adapter doesn't request prompt caching",
  }
}

/**
 * Resolve the capture level a call's loop runs at: the call's, else the
 * engine default, else `'off'`. On the ai_sdk transport the SDK builds the
 * body, so `'wire'` records `option_ignored` and runs as `'turns'`.
 */
function resolve_capture<T>(opts: GenerateOptions<T>, engine: EngineInternals, call: CallShape): CaptureLevel {
  const level = opts.capture ?? engine.default_capture ?? 'off'
  if (level !== 'wire' || call.adapter.kind !== 'ai_sdk') return level
  create_option_ignored_dedup(call.trajectory).emit('capture', call.adapter.name, 'wire capture needs a native transport')
  // Stryker disable next-line StringLiteral: the loop reads a level only against 'off' and 'wire', so any other string captures as 'turns' does.
  return 'turns'
}

/**
 * Resolve the per-turn knobs (effort, cache, capture, retry policy, turn
 * timeout) against engine defaults. Validated here, before any transport is built, so
 * a bad budget fails as a config error, never as a spurious timeout. A cache
 * setting the adapter can't honor records `option_ignored` with its reason.
 */
function resolve_turn_config<T>(
  opts: GenerateOptions<T>,
  engine: EngineInternals,
  call: CallShape,
): TurnConfig {
  const effort: EffortLevel = opts.effort ?? engine.default_effort
  const retry_policy = opts.retry ?? engine.default_retry
  const turn_timeout_ms = opts.turn_timeout_ms ?? engine.default_turn_timeout_ms
  if (turn_timeout_ms !== undefined && turn_timeout_ms <= 0) {
    // A zero/negative budget would fire the deadline before the request even
    // starts; reject rather than silently disable or hang.
    throw new engine_config_error(`turn_timeout_ms must be > 0, got ${String(turn_timeout_ms)}`)
  }
  const { cache, ignored_reason } = resolve_cache(
    declared_caching(call.adapter),
    opts.cache ?? engine.default_cache,
    call.tools.length > 0,
  )
  if (ignored_reason !== undefined) {
    create_option_ignored_dedup(call.trajectory).emit('cache', call.adapter.name, ignored_reason)
  }
  return { effort, cache, capture: resolve_capture(opts, engine, call), retry_policy, turn_timeout_ms }
}

type LoopLimits = {
  readonly max_steps: number
  readonly tool_error_policy: 'feed_back' | 'throw'
  readonly schema_repair_attempts: number
  readonly salvage_budget: { remaining: number } | undefined
  readonly max_tool_calls_per_step: number | undefined
}

/**
 * Resolve the tool-call salvage budget. Returned as a holder rather than a
 * count: one holder per generate call so schema-repair re-invocations of the
 * loop cannot refill the salvage budget. undefined disables salvage.
 */
function resolve_salvage_budget<T>(
  opts: GenerateOptions<T>,
  engine: EngineInternals,
): { remaining: number } | undefined {
  const tool_call_repair_attempts =
    opts.tool_call_repair_attempts ?? engine.default_tool_call_repair_attempts ?? 0
  if (tool_call_repair_attempts < 0) {
    throw new engine_config_error(
      `tool_call_repair_attempts must be >= 0, got ${String(tool_call_repair_attempts)}`,
    )
  }
  return tool_call_repair_attempts > 0
    ? { remaining: tool_call_repair_attempts }
    : undefined
}

/**
 * Resolve the loop-level limits and policies against engine defaults,
 * rejecting configurations the tool loop cannot honor.
 */
function resolve_loop_limits<T>(
  opts: GenerateOptions<T>,
  engine: EngineInternals,
): LoopLimits {
  const max_steps = opts.max_steps ?? engine.default_max_steps
  const tool_error_policy =
    // Stryker disable next-line StringLiteral: run_tool_loop treats any non-'throw' policy as feed_back, so '' and 'feed_back' resolve to identical behavior.
    opts.tool_error_policy ?? engine.default_tool_error_policy ?? 'feed_back'
  const schema_repair_attempts =
    opts.schema_repair_attempts ?? engine.default_schema_repair_attempts ?? 1
  const salvage_budget = resolve_salvage_budget(opts, engine)
  const max_tool_calls_per_step =
    opts.max_tool_calls_per_step ?? engine.default_max_tool_calls_per_step
  if (max_tool_calls_per_step !== undefined && max_tool_calls_per_step < 1) {
    // A cap of 0 would drop every call and strand the loop in its stop
    // branch with orphaned records; reject rather than guess.
    throw new engine_config_error(
      `max_tool_calls_per_step must be >= 1, got ${String(max_tool_calls_per_step)}`,
    )
  }
  return {
    max_steps,
    tool_error_policy,
    schema_repair_attempts,
    salvage_budget,
    max_tool_calls_per_step,
  }
}

/**
 * Merge two of an adapter's translations into call-level provider options,
 * key by key under each provider, with `over` winning where both set a key.
 */
function merge_translations(
  base: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  over: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = { ...base }
  for (const [provider, inner] of Object.entries(over)) out[provider] = { ...base[provider], ...inner }
  return out
}

type AiSdkTransportConfig<T> = {
  readonly adapter: AiSdkProviderAdapter
  readonly target: ResolvedModel
  readonly opts: GenerateOptions<T>
  readonly effort: EffortLevel
  readonly cache: CacheSetting
  readonly retry_policy: RetryPolicy
  readonly turn_timeout_ms: number | undefined
  readonly dispatcher: ChunkDispatcher
  readonly tools_list: ReadonlyArray<Tool>
  readonly trajectory: TrajectoryLogger | undefined
  readonly telemetry: AiSdkTelemetrySettings | undefined
  readonly on_chunk_provided: boolean
}

/**
 * Build the ai_sdk-transport InvokeOnce for one call: translate effort and
 * the cache setting, merge provider options, load the SDK seam, and wrap it
 * in the engine-owned retry via build_ai_sdk_invoke.
 */
async function build_ai_sdk_transport<T>(
  cfg: AiSdkTransportConfig<T>,
): Promise<InvokeOnce> {
  const { adapter, opts, effort } = cfg
  const effort_translation = adapter.translate_effort(effort)
  // Stryker disable next-line LogicalOperator,StringLiteral: no adapter reports effort_ignored for effort 'none', so && vs || and 'none' vs '' cannot change whether this records (the ConditionalExpression twins are covered by the effort tests).
  if (effort !== 'none' && effort_translation.effort_ignored) {
    record_effort_ignored(cfg.trajectory, cfg.target.model_id)
  }
  // The effort and cache translations are the lowest-precedence layer;
  // engine defaults and per-call provider_options (already merged into
  // opts.provider_options, with per-call winning) override them.
  const cache_options = adapter.translate_cache?.(cfg.cache, opts.provider_options) ?? {}
  const combined_provider_options = merge_provider_options(
    merge_translations(effort_translation.provider_options, cache_options),
    opts.provider_options,
  )
  const provider_options =
    combined_provider_options !== undefined &&
    Object.keys(combined_provider_options).length > 0
      ? combined_provider_options
      : undefined

  // All SDK specifics (message/tool mapping, Output.object structured-output
  // gating, the streamText call) live behind create_ai_sdk_turn;
  // this builder only threads resolved options through the seam.
  //
  // Imported here rather than at the top of the file because a static import
  // would put `ai` on every consumer's module graph: loading it inside the
  // ai_sdk branch keeps it off the graph of a native-transport install. The
  // module resolves once per process and is cached thereafter, so the cost
  // falls on the first ai_sdk call only. On failure this rethrows
  // via missing_peer_error naming `ai` (the peer this module's own static
  // `from 'ai'` import reaches for), not a raw module-resolution error
  // naming this local path.
  let ai_sdk_invoke_mod: typeof import('./providers/ai_sdk/invoke.js')
  try {
    ai_sdk_invoke_mod = await import('./providers/ai_sdk/invoke.js')
  } catch (err: unknown) {
    throw missing_peer_error('ai', err)
  }
  const { create_ai_sdk_turn } = ai_sdk_invoke_mod
  return build_ai_sdk_invoke({
    invoke_turn: create_ai_sdk_turn({
      adapter,
      model_id: cfg.target.model_id,
      dispatcher: cfg.dispatcher,
      tools: cfg.tools_list,
      schema: opts.schema,
      // The merge produces the two-level per-provider shape the seam
      // declares; the merged value is typed loosely upstream.
      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      provider_options: provider_options as AiSdkTurnConfig['provider_options'],
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
      top_p: opts.top_p,
      reasoning: effort_translation.reasoning,
      telemetry: cfg.telemetry,
    }),
    retry_policy: cfg.retry_policy,
    turn_timeout_ms: cfg.turn_timeout_ms,
    trajectory: cfg.trajectory,
    on_chunk_provided: cfg.on_chunk_provided,
  })
}

/**
 * Build the message list one generate call starts from. When a schema is set,
 * the JSON-only instruction folds into the existing system message (or is
 * prepended as one) so the model sees it exactly once, wherever the system
 * prompt came from.
 */
function build_prompt_messages<T>(opts: GenerateOptions<T>): Message[] {
  const schema_prefix = opts.schema !== undefined ? schema_instruction(opts.schema) : undefined
  const initial_messages = build_initial_messages(opts)
  if (schema_prefix !== undefined) {
    const idx = initial_messages.findIndex((m) => m.role === 'system')
    if (idx >= 0) {
      const sys = initial_messages[idx]
      // Stryker disable next-line OptionalChaining: sys is initial_messages[idx] at a found index, so it is always a defined system Message; sys.role and sys?.role read identically.
      if (sys?.role === 'system') {
        initial_messages[idx] = {
          role: 'system',
          content: `${sys.content}\n\n${schema_prefix}`,
        }
      }
    } else {
      initial_messages.unshift({ role: 'system', content: schema_prefix })
    }
  }
  return initial_messages
}

const JSON_ONLY = 'Return ONLY the JSON value, with no markdown or commentary.'

/**
 * The instruction that asks for a JSON reply, with the schema that the reply has to fit.
 *
 * The instruction is the only place where most transports show the model the
 * schema. Only an `ai_sdk` adapter with the `structured_output` capability
 * hands the schema to the provider, and only on a call without tools, so
 * everywhere else a bare request would leave the model guessing the field
 * names while the repair loop taught them one failed reply at a time.
 *
 * A schema that can't be emitted keeps the bare request. A vendor without
 * Standard JSON Schema throws, and so does zod for a type that JSON Schema
 * can't express (a `Date`), and both of those schemas validate replies without
 * it, so a failed emission must not fail the call.
 */
function schema_instruction(schema: ToolSchema): string {
  try {
    const shown = JSON.stringify(to_json_schema(schema, { strip_meta: true }))
    return `You must respond with a single JSON value that conforms to this JSON Schema:\n\n${shown}\n\n${JSON_ONLY}`
  } catch {
    return `You must respond with a single JSON value that conforms to the expected schema. ${JSON_ONLY}`
  }
}

type LoopConfigInputs<T> = {
  readonly opts: GenerateOptions<T>
  readonly target: ResolvedModel
  readonly pricing: PricingTable
  readonly invoke_once: InvokeOnce
  readonly messages: Message[]
  readonly tools_list: ReadonlyArray<Tool>
  readonly trajectory: TrajectoryLogger | undefined
  readonly dispatcher: ChunkDispatcher
  readonly on_chunk_provided: boolean
  readonly limits: LoopLimits
  readonly capture: LoopCapture
}

/**
 * Assemble the ToolLoopConfig base shared by every loop invocation of one
 * generate call. Everything here is per-call state: the mutable transcript,
 * the pricing lookup, the pricing_missing dedup, and the call memory that
 * carries the previous turn's cache traffic and captured messages all live
 * for exactly one call,
 * which is what lets schema-repair re-invocations share them. The
 * conditional spreads keep optional fields absent rather than undefined for
 * exactOptionalPropertyTypes.
 */
function build_loop_config<T>(
  cfg: LoopConfigInputs<T>,
): Omit<ToolLoopConfig, 'step_index_start'> {
  const { opts, target, limits } = cfg
  const abort = opts.abort ?? new AbortController().signal
  const resolve_pricing = (): Pricing | undefined => {
    return cfg.pricing[pricing_key(target.provider, target.model_id)]
  }
  // The parentheses are for Stryker: Babel 8, which it parses source with,
  // rejects an async arrow with a return type as a branch of a ternary.
  const dispatch_chunk =
    cfg.on_chunk_provided
      ? (async (chunk: StreamChunk): Promise<void> => {
          await cfg.dispatcher.dispatch(chunk)
        })
      : undefined
  return {
    invoke_once: cfg.invoke_once,
    messages: cfg.messages,
    tools: cfg.tools_list,
    max_steps: limits.max_steps,
    tool_error_policy: limits.tool_error_policy,
    abort,
    on_tool_approval: opts.on_tool_approval,
    trajectory: cfg.trajectory,
    stream: cfg.on_chunk_provided,
    dispatch_chunk,
    provider: target.provider,
    model_id: target.model_id,
    resolve_pricing,
    pricing_dedup: create_pricing_missing_dedup(cfg.trajectory),
    // Stryker disable next-line ObjectLiteral: an empty holder reads previous_cache_traffic as undefined, which the loop's `> 0` test treats as 0.
    call_memory: { previous_cache_traffic: 0 },
    capture: cfg.capture,
    ...(limits.salvage_budget !== undefined
      ? { salvage_budget: limits.salvage_budget }
      : {}),
    ...(limits.max_tool_calls_per_step !== undefined
      ? { max_tool_calls_per_step: limits.max_tool_calls_per_step }
      : {}),
    ...(opts.prepare_step !== undefined ? { prepare_step: opts.prepare_step } : {}),
  }
}

type SchemaStepConfig<T> = {
  readonly schema: NonNullable<GenerateOptions<T>['schema']>
  readonly text: string
  readonly trajectory: TrajectoryLogger | undefined
  readonly attempt: 'initial' | 'repair'
  readonly can_repair: boolean
}

type SchemaStepOutcome<T> =
  | { readonly parsed: { readonly value: T } }
  | { readonly repair_message: Message }

/**
 * One schema-validation pass over the loop's final text. A successful parse
 * returns the value in a holder (a schema can legitimately validate to
 * undefined, which must stay distinguishable from "nothing parsed"). A failed
 * parse records the trajectory event first, then either throws (`can_repair`
 * false: the repair or step budget is spent) or hands back the repair message
 * to append before re-invoking the loop.
 */
async function parse_schema_step<T>(
  cfg: SchemaStepConfig<T>,
): Promise<SchemaStepOutcome<T>> {
  const parse = await parse_with_schema(cfg.schema, cfg.text)
  if (parse.ok) return { parsed: { value: parse.value } }
  record_schema_validation_failed(cfg.trajectory, {
    attempt: cfg.attempt,
    schema_issues: format_schema_issues(parse.issues),
    raw_text: cfg.text,
  })
  if (!cfg.can_repair) throw_schema_validation(parse.issues, cfg.text)
  return { repair_message: build_repair_message(parse.issues) }
}

type GenerateLoopConfig<T> = {
  readonly base: Omit<ToolLoopConfig, 'step_index_start'>
  readonly schema: GenerateOptions<T>['schema']
  readonly schema_repair_attempts: number
}

type GenerateLoopOutcome<T> = {
  readonly steps: GenerateResult<T>['steps']
  readonly tool_calls: GenerateResult<T>['tool_calls']
  readonly text: string
  readonly finish_reason: FinishReason
  readonly content_parsed: { value: T } | undefined
}

/**
 * Drive run_tool_loop to a final answer, re-invoking it for schema repair.
 *
 * Without a schema this is a single loop invocation. With one, the final text
 * must parse: a non-'stop' finish reason means no validated value can exist
 * (a content filter, the token limit, the step cap), so this throws
 * incomplete_generation_error rather than returning unchecked text; a failed
 * parse appends the repair message to the shared transcript and re-enters the
 * loop until the response parses, repair attempts run out, or max_steps is
 * reached. step_index_start advances by the accumulated step count so step
 * indices stay call-global across re-invocations.
 */
async function run_generate_loop<T>(
  cfg: GenerateLoopConfig<T>,
): Promise<GenerateLoopOutcome<T>> {
  const { base, schema } = cfg
  const steps_accum: GenerateResult<T>['steps'] = []
  const tool_calls_accum: GenerateResult<T>['tool_calls'] = []
  // Stryker disable next-line StringLiteral: text is overwritten by loop_result.text on the first (guaranteed) loop iteration before it is ever read.
  let text = ''
  // Stryker disable next-line StringLiteral: finish_reason is overwritten by loop_result.finish_reason before it is read.
  let finish_reason: FinishReason = 'stop'
  let repair_remaining = cfg.schema_repair_attempts
  // A holder rather than a bare `T | undefined`: a schema can legitimately
  // validate to undefined (a `.transform()` or `.catch()` that returns it), and
  // that has to stay distinguishable from "nothing parsed".
  let content_parsed: { value: T } | undefined

  while (true) {
    const loop_result = await run_tool_loop({
      ...base,
      step_index_start: steps_accum.length,
    })
    for (const s of loop_result.steps) steps_accum.push(s)
    for (const tc of loop_result.tool_calls) tool_calls_accum.push(tc)
    text = loop_result.text
    finish_reason = loop_result.finish_reason

    if (schema === undefined) break
    if (finish_reason !== 'stop') {
      throw new incomplete_generation_error(
        finish_reason,
        text,
        last_provider_reported(steps_accum),
      )
    }
    const schema_step = await parse_schema_step<T>({
      schema,
      text,
      trajectory: base.trajectory,
      attempt: repair_remaining === cfg.schema_repair_attempts ? 'initial' : 'repair',
      can_repair: repair_remaining > 0 && steps_accum.length < base.max_steps,
    })
    if ('parsed' in schema_step) {
      content_parsed = schema_step.parsed
      break
    }
    repair_remaining -= 1
    base.messages.push(schema_step.repair_message)
  }

  return {
    steps: steps_accum,
    tool_calls: tool_calls_accum,
    text,
    finish_reason,
    content_parsed,
  }
}

/**
 * Fold the loop outcome into the caller-facing GenerateResult: usage and cost
 * aggregate across every step (schema-repair re-invocations included), the
 * content is the parsed holder's value when a schema ran, and cost /
 * provider_reported attach only when a step actually reported them.
 */
function assemble_result<T>(
  outcome: GenerateLoopOutcome<T>,
  target: ResolvedModel,
): GenerateResult<T> {
  const aggregated_usage = sum_usage(outcome.steps)
  const aggregated_cost = aggregate_cost(outcome.steps, target.provider)

  let final_content: T
  if (outcome.content_parsed !== undefined) {
    final_content = outcome.content_parsed.value
  } else {
    // No schema, so there is nothing to validate and the raw text is the
    // content. A schema call cannot arrive here: the loop either filled the
    // holder or threw.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    final_content = outcome.text as T
  }

  const result: GenerateResult<T> = {
    content: final_content,
    tool_calls: outcome.tool_calls,
    steps: outcome.steps,
    usage: aggregated_usage,
    finish_reason: outcome.finish_reason,
    model_resolved: { provider: target.provider, model_id: target.model_id },
  }
  if (aggregated_cost !== undefined) result.cost = aggregated_cost
  const aggregated_reported = last_provider_reported(outcome.steps)
  if (aggregated_reported !== undefined) result.provider_reported = aggregated_reported
  return result
}

/**
 * The settings a call's first captured turn records: the provider and the
 * model, the resolved effort and cache (left out when off), the sampling
 * knobs it set, its provider options as the engine defaults and the call
 * merged them, before an adapter's translation of effort or cache adds to
 * them, and its schema as JSON Schema, left out when it can't be written as
 * one. An unset field stays undefined, which the loop's JSON copy leaves out.
 */
function capture_settings<T>(
  opts: GenerateOptions<T>,
  target: ResolvedModel,
  turn: TurnConfig,
): Record<string, unknown> {
  return {
    provider: target.provider,
    model_id: target.model_id,
    effort: turn.effort,
    cache: turn.cache === 'off' ? undefined : turn.cache,
    temperature: opts.temperature,
    max_tokens: opts.max_tokens,
    top_p: opts.top_p,
    provider_options: opts.provider_options,
    // Stryker disable next-line ConditionalExpression: without the guard, to_json_schema throws on an undefined schema, which json_schema_or_undefined reads as undefined too.
    schema: opts.schema === undefined ? undefined : json_schema_or_undefined(opts.schema),
  }
}

/**
 * Resolve a `generate` call's options against engine defaults, run the tool
 * loop, and return the aggregated result.
 *
 * A provider whose adapter is `external` (`adapter.kind === 'external'`)
 * delegates the whole call to `adapter.generate` before any of the logic
 * below runs. For `ai_sdk` and native adapters, this function resolves
 * model, provider, system prompt, and `provider_options` against engine
 * defaults, checks the adapter supports every capability the call actually
 * uses (schema, tools, streaming), builds the `InvokeOnce` closure for the
 * resolved transport, and drives it through `run_tool_loop`. When a schema
 * is set and the model's output fails validation, it appends a repair
 * message and re-invokes the loop, until the response parses, repair
 * attempts run out, or `max_steps` is reached. When a schema is set and the
 * loop finishes for any reason other than `'stop'` (a content filter, the
 * token limit, the step cap), no validated value can exist, so it throws
 * `incomplete_generation_error` carrying the finish reason, the raw text,
 * and the last `provider_reported` payload rather than returning unchecked
 * text. Without a schema those finish reasons return normally. Every result,
 * an external adapter's included, leaves with `timing` stamped over the
 * whole call.
 */
export async function generate<T = string>(
  opts_in: GenerateOptions<T>,
  engine: EngineInternals,
): Promise<GenerateResult<T>> {
  const started_at = Date.now()
  if (opts_in.abort?.aborted === true) {
    throw new aborted_error('aborted', { reason: opts_in.abort.reason })
  }

  const { opts, target } = resolve_target(opts_in, engine)

  const adapter = engine.adapters.get(target.provider)
  if (adapter === undefined) {
    throw new provider_not_configured_error(target.provider, [...engine.adapters.keys()])
  }
  assert_unique_tool_names(opts.tools)
  assert_cache_setting(opts.cache, 'cache')
  assert_capture_level(opts.capture, 'capture')

  if (adapter.kind === 'external') {
    const external = await adapter.generate<T>(opts, target)
    return { ...external, timing: call_timing(started_at) }
  }

  // Stamp engine events with `ts` when generate is called directly with a
  // caller-supplied logger. A runner-decorated logger already carries `ts`;
  // with_timestamps preserves it.
  const trajectory = with_timestamps(opts.trajectory)
  const on_chunk_provided = opts.on_chunk !== undefined
  const tools_list: ReadonlyArray<Tool> = opts.tools ?? []

  assert_capabilities(adapter, target.provider, opts, tools_list, on_chunk_provided)

  const turn = resolve_turn_config(opts, engine, { adapter, tools: tools_list, trajectory })
  const dispatcher = create_chunk_dispatcher(opts.on_chunk)

  let invoke_once: InvokeOnce
  if (adapter.kind === 'ai_sdk') {
    invoke_once = await build_ai_sdk_transport({
      adapter,
      target,
      opts,
      effort: turn.effort,
      cache: turn.cache,
      retry_policy: turn.retry_policy,
      turn_timeout_ms: turn.turn_timeout_ms,
      dispatcher,
      tools_list,
      trajectory,
      telemetry: engine.default_ai_sdk_telemetry,
      on_chunk_provided,
    })
  } else {
    // No effort translation here: a native adapter receives the resolved
    // effort level on TurnRequest and owns its own mapping, so
    // provider_options stays the plain defaults + per-call merge.
    invoke_once = build_native_invoke({
      adapter,
      model_id: target.model_id,
      retry_policy: turn.retry_policy,
      turn_timeout_ms: turn.turn_timeout_ms,
      trajectory,
      dispatcher,
      effort: turn.effort,
      cache: turn.cache,
      schema: opts.schema,
      // The merge produces the two-level per-provider shape TurnRequest
      // declares; GenerateOptions types it loosely as Record<string, unknown>.
      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      provider_options: opts.provider_options as TurnRequest['provider_options'],
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
      top_p: opts.top_p,
      on_chunk_provided,
    })
  }

  const limits = resolve_loop_limits(opts, engine)
  const initial_messages = build_prompt_messages(opts)

  const generate_span = start_generate_span(trajectory, {
    model: target.model_id,
    provider: target.provider,
    model_id: target.model_id,
    has_tools: tools_list.length > 0,
    has_schema: opts.schema !== undefined,
    streaming: on_chunk_provided,
  })

  const base = build_loop_config({
    opts,
    target,
    pricing: engine.pricing,
    invoke_once,
    messages: [...initial_messages],
    tools_list,
    trajectory,
    dispatcher,
    on_chunk_provided,
    limits,
    capture: {
      level: turn.capture,
      call_span_id: generate_span,
      settings: () => capture_settings(opts, target, turn),
      redact: engine.redact_capture,
    },
  })

  try {
    const outcome = await run_generate_loop<T>({
      base,
      schema: opts.schema,
      schema_repair_attempts: limits.schema_repair_attempts,
    })
    const result = assemble_result(outcome, target)

    if (on_chunk_provided) {
      await dispatcher.dispatch({
        kind: 'finish',
        finish_reason: outcome.finish_reason,
        usage: result.usage,
      })
    }

    end_generate_span(trajectory, generate_span, {
      usage: result.usage,
      finish_reason: outcome.finish_reason,
      model_resolved: result.model_resolved,
      step_count: result.steps.length,
      tool_call_count: result.tool_calls.length,
    })
    result.timing = call_timing(started_at)
    return result
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    end_generate_span(trajectory, generate_span, { error: message })
    throw err
  }
}

/**
 * Close a generate call's wall-clock window opened at `started_at`.
 */
function call_timing(started_at: number): GenerateTiming {
  return { started_at, duration_ms: Date.now() - started_at }
}

/**
 * Pick the call-level `provider_reported` from the step records: the payload of
 * the last step that reported one.
 *
 * Provider payloads are opaque, so unlike usage and cost there is nothing to
 * sum and no safe way to merge two turns' keys (a provider reports the same keys
 * every turn, so merging would silently overwrite rather than combine). Taking
 * the final reporting turn matches how `content` and `finish_reason` are drawn
 * from the last turn; every turn's own payload stays on `steps[i]`.
 */
export function last_provider_reported(
  steps: ReadonlyArray<GenerateResult['steps'][number]>,
): Record<string, unknown> | undefined {
  return steps.findLast((s) => s.provider_reported !== undefined)?.provider_reported
}

/**
 * Running totals accumulated across per-step cost breakdowns. Each optional
 * field carries a `_present` flag so the final breakdown can include it only
 * when at least one step reported it, distinct from a summed zero.
 */
interface CostAccumulator {
  any_present: boolean
  total: number
  input: number
  output: number
  cached_present: boolean
  cached: number
  cache_write_present: boolean
  cache_write: number
  reasoning_present: boolean
  reasoning: number
}

/**
 * Fold every step's `cost` into a single {@link CostAccumulator}, skipping steps
 * that reported none. The required fields always sum; each optional field sums
 * and flips its `_present` flag only on the steps that carried it.
 */
function sum_step_costs(
  steps: ReadonlyArray<GenerateResult['steps'][number]>,
): CostAccumulator {
  const acc: CostAccumulator = {
    any_present: false,
    total: 0,
    input: 0,
    output: 0,
    cached_present: false,
    cached: 0,
    cache_write_present: false,
    cache_write: 0,
    reasoning_present: false,
    reasoning: 0,
  }
  for (const s of steps) {
    if (s.cost === undefined) continue
    acc.any_present = true
    acc.total += s.cost.total_usd
    acc.input += s.cost.input_usd
    acc.output += s.cost.output_usd
    if (s.cost.cached_input_usd !== undefined) {
      acc.cached_present = true
      acc.cached += s.cost.cached_input_usd
    }
    if (s.cost.cache_write_usd !== undefined) {
      acc.cache_write_present = true
      acc.cache_write += s.cost.cache_write_usd
    }
    if (s.cost.reasoning_usd !== undefined) {
      acc.reasoning_present = true
      acc.reasoning += s.cost.reasoning_usd
    }
  }
  return acc
}

/**
 * Sum per-step cost breakdowns into a single `CostBreakdown` for the whole
 * generate call.
 *
 * Returns `undefined` if no step reports a cost, unless `provider` is free
 * (`FREE_PROVIDERS`) and at least one step ran; in that case it returns an
 * explicit all-zero breakdown instead of omitting cost entirely. The
 * optional fields (`cached_input_usd`, `cache_write_usd`, `reasoning_usd`)
 * are included only when at least one step reported them.
 */
export function aggregate_cost(
  steps: ReadonlyArray<GenerateResult['steps'][number]>,
  provider: string,
): CostBreakdown | undefined {
  const acc = sum_step_costs(steps)
  if (!acc.any_present) {
    if (FREE_PROVIDERS.has(provider) && steps.length > 0) {
      return {
        total_usd: 0,
        input_usd: 0,
        output_usd: 0,
        currency: 'USD',
        is_estimate: true,
      }
    }
    return undefined
  }
  const out: CostBreakdown = {
    total_usd: round6(acc.total),
    input_usd: round6(acc.input),
    output_usd: round6(acc.output),
    currency: 'USD',
    is_estimate: true,
  }
  if (acc.cached_present) out.cached_input_usd = round6(acc.cached)
  if (acc.cache_write_present) out.cache_write_usd = round6(acc.cache_write)
  if (acc.reasoning_present) out.reasoning_usd = round6(acc.reasoning)
  return out
}

