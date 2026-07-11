/**
 * generate(opts) — single public entry point for model calls.
 *
 * This file is SDK-agnostic (constraints §7 invariant 13, inverted): it
 * resolves options, gates capabilities, and owns retry + trajectory, and it
 * drives every depth-1 turn — ai_sdk and native alike — through the neutral
 * invoke_turn seam. The Vercel AI SDK call itself lives in
 * providers/ai_sdk/invoke.ts, the only module allowed to import from `ai`
 * (rule no-ai-import-outside-ai-sdk-provider). tool_loop.ts consumes the
 * InvokeOnce seam built here.
 */

import type {
  CostBreakdown,
  EffortLevel,
  FinishReason,
  GenerateOptions,
  GenerateResult,
  Message,
  Pricing,
  PricingTable,
  ResolvedModel,
  RetryPolicy,
  StreamChunk,
  Tool,
  TurnRequest,
  TurnResult,
} from './types.js'
import {
  aborted_error,
  engine_config_error,
  model_required_error,
  on_chunk_error,
  provider_capability_error,
  provider_error,
  provider_not_configured_error,
  turn_timeout_error,
} from './errors.js'
import { merge_provider_options } from './merge_defaults.js'
import { FREE_PROVIDERS, pricing_key } from './pricing.js'
import { parse_retry_after, retry_with_policy } from './retry.js'
import {
  build_repair_message,
  format_zod_error,
  parse_with_schema,
  throw_schema_validation,
} from './schema.js'
import {
  create_chunk_dispatcher,
  type ChunkDispatcher,
} from './streaming.js'
import {
  create_pricing_missing_dedup,
  end_generate_span,
  record_effort_ignored,
  record_schema_validation_failed,
  start_generate_span,
  with_timestamps,
} from './trajectory.js'
import { sum_usage } from './usage.js'
import {
  run_tool_loop,
  type InvokeOnce,
  type InvokeOnceArgs,
  type InvokeOnceResult,
} from './tool_loop.js'
import type {
  NativeProviderAdapter,
  ProviderAdapter,
} from './providers/types.js'
import {
  create_ai_sdk_turn,
  type AiSdkTurn,
  type AiSdkTurnConfig,
} from './providers/ai_sdk/invoke.js'

export type EngineInternals = {
  readonly pricing: PricingTable
  readonly adapters: ReadonlyMap<string, ProviderAdapter>
  readonly default_retry: RetryPolicy
  readonly default_effort: EffortLevel
  readonly default_max_steps: number
  readonly default_turn_timeout_ms?: number
  readonly default_model?: string
  readonly default_provider?: string
  readonly default_system?: string
  readonly default_tool_error_policy?: 'feed_back' | 'throw'
  readonly default_schema_repair_attempts?: number
  readonly default_tool_call_repair_attempts?: number
  readonly default_max_tool_calls_per_step?: number
  readonly default_provider_options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

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
  let run_end = 0
  const system_parts: string[] = []
  while (run_end < messages.length) {
    const m = messages[run_end]
    if (m?.role !== 'system') break
    system_parts.push(m.content)
    run_end += 1
  }
  const rest = messages.slice(run_end)
  if (system_parts.length === 0 || rest.length === 0) {
    return { messages: [...messages] }
  }
  return { system: system_parts.join('\n\n'), messages: rest }
}

export function classify_provider_error(err: unknown): unknown {
  if (err === null || typeof err !== 'object') return err
  // Already-classified shape: pass through.
  const existing_kind = Reflect.get(err, 'kind')
  if (
    typeof existing_kind === 'string' &&
    (existing_kind === 'rate_limit' ||
      existing_kind === 'provider_5xx' ||
      existing_kind === 'network' ||
      existing_kind === 'timeout')
  ) {
    return err
  }
  const status = Reflect.get(err, 'statusCode')
  const status_alt = Reflect.get(err, 'status')
  const resolved_status =
    typeof status === 'number'
      ? status
      : typeof status_alt === 'number'
        ? status_alt
        : undefined
  if (resolved_status === 429) {
    const headers = Reflect.get(err, 'responseHeaders')
    let retry_after_ms: number | undefined
    if (headers !== null && typeof headers === 'object') {
      const hv = Reflect.get(headers, 'retry-after')
      if (typeof hv === 'string') retry_after_ms = parse_retry_after(hv)
    }
    const message = Reflect.get(err, 'message')
    const out: Record<string, unknown> = { kind: 'rate_limit', status: 429 }
    if (typeof message === 'string') out['message'] = message
    if (retry_after_ms !== undefined) out['retry_after_ms'] = retry_after_ms
    return out
  }
  if (resolved_status !== undefined && resolved_status >= 500 && resolved_status < 600) {
    const message = Reflect.get(err, 'message')
    const out: Record<string, unknown> = { kind: 'provider_5xx', status: resolved_status }
    if (typeof message === 'string') out['message'] = message
    return out
  }
  const code = Reflect.get(err, 'code')
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED'
  ) {
    const message = Reflect.get(err, 'message')
    const out: Record<string, unknown> = { kind: 'network' }
    if (typeof message === 'string') out['message'] = message
    return out
  }
  return err
}

type AiSdkInvokeConfig = {
  readonly invoke_turn: AiSdkTurn
  readonly retry_policy: RetryPolicy
  readonly turn_timeout_ms: number | undefined
}

type NativeInvokeConfig = {
  readonly adapter: NativeProviderAdapter
  readonly model_id: string
  readonly retry_policy: RetryPolicy
  readonly turn_timeout_ms: number | undefined
  readonly dispatcher: ChunkDispatcher
  readonly effort: EffortLevel
  readonly schema: TurnRequest['schema']
  readonly provider_options: TurnRequest['provider_options']
  readonly temperature: number | undefined
  readonly max_tokens: number | undefined
  readonly top_p: number | undefined
}

type TurnDeadline = {
  readonly signal: AbortSignal
  readonly timed_out: () => boolean
  readonly dispose: () => void
}

/**
 * Compose the per-attempt turn signal (D5): the user's abort OR'd with a fresh
 * `turn_timeout_ms` deadline via AbortSignal.any (the src/core/timeout.ts
 * precedent). `timed_out()` distinguishes an expiry (retryable) from a user
 * abort (terminal) in the retry_turn ladder; `dispose()` clears the timer so a
 * settled attempt never leaves one armed. With no budget the user's abort
 * passes through untouched, so the un-timed path stays byte-for-byte as before.
 * Armed fresh inside retry_with_policy's callback so each retry gets its own
 * full budget rather than sharing one deadline across attempts.
 */
function arm_turn_timeout(
  user_abort: AbortSignal,
  turn_timeout_ms: number | undefined,
): TurnDeadline {
  if (turn_timeout_ms === undefined) {
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
 * Engine-owned wrapper shared verbatim by both depth-1 transports: one turn
 * attempt inside retry_with_policy. The catch ladder classifies by CAUSE, not
 * by the shape the transport happened to throw: on_chunk_error passes through,
 * then a genuine user abort wins, then any error once a chunk has flowed is a
 * non-retryable stream interruption, then a pre-chunk `turn_timeout_ms` expiry
 * is a retryable typed timeout, and only a below-loop aborted_error unrelated
 * to either passes through. Cause-first ordering is what keeps the two
 * transports in parity: the ai_sdk transport reports a mid-stream abort as an
 * aborted_error and the native one as a raw AbortError, so both must be read as
 * the same interruption rather than the ai_sdk timeout masquerading as a user
 * cancel. call_once receives the composed abort+timeout signal so the deadline
 * actually cancels the in-flight request. Adapters may swap `classify`, never
 * the ladder (D5: the engine owns retry; hidden adapter retries are illegible).
 */
function retry_turn(
  call_once: (turn_abort: AbortSignal) => Promise<TurnResult>,
  args: InvokeOnceArgs,
  has_streamed: () => boolean,
  retry_policy: RetryPolicy,
  classify: (err: unknown) => unknown,
  turn_timeout_ms: number | undefined,
): Promise<TurnResult> {
  return retry_with_policy(
    async () => {
      const deadline = arm_turn_timeout(args.abort, turn_timeout_ms)
      try {
        return await call_once(deadline.signal)
      } catch (err: unknown) {
        if (err instanceof on_chunk_error) throw err
        // A genuine user abort wins over everything below it — including a
        // deadline that fired in the same tick — so an intentional cancel
        // always surfaces as aborted_error.
        if (args.abort.aborted) {
          throw new aborted_error('aborted', {
            reason: args.abort.reason,
            step_index: args.step_index,
          })
        }
        // Any failure once a chunk has flowed is a non-retryable stream
        // interruption, a deadline expiry included (a retry would re-emit
        // output the consumer already saw). Checked before the aborted_error
        // pass-through so a mid-stream ai_sdk abort classifies here, in parity
        // with the native transport's raw AbortError.
        if (has_streamed()) {
          const message = err instanceof Error ? err.message : String(err)
          throw new provider_error(`stream interrupted: ${message}`, {
            cause_kind: 'unknown',
          })
        }
        // A pre-chunk deadline expiry is a retryable typed timeout, whatever
        // shape the transport threw when its signal aborted. turn_timeout_ms is
        // defined whenever timed_out() can be true.
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
  )
}

/**
 * Build the ai_sdk-transport InvokeOnce: the SDK turn built by
 * providers/ai_sdk/invoke.ts behind the same engine-owned retry_turn wrapper
 * the native path uses. The SDK call body lives behind the seam; this builder
 * owns only retry and the streamed-output tracking that makes a mid-stream
 * failure a non-retryable interruption.
 */
function build_ai_sdk_invoke(cfg: AiSdkInvokeConfig): InvokeOnce {
  return async (args: InvokeOnceArgs): Promise<InvokeOnceResult> => {
    let chunks_started = false
    const call_once = (turn_abort: AbortSignal): Promise<TurnResult> =>
      cfg.invoke_turn({
        step_index: args.step_index,
        messages: args.messages,
        abort: turn_abort,
        stream: args.stream,
        on_first_chunk: () => {
          chunks_started = true
        },
      })

    return await retry_turn(
      call_once,
      args,
      () => chunks_started,
      cfg.retry_policy,
      classify_provider_error,
      cfg.turn_timeout_ms,
    )
  }
}

/**
 * Build the native-transport InvokeOnce: maps the loop's InvokeOnceArgs to a
 * TurnRequest and calls adapter.invoke_turn inside the same retry_turn
 * wrapper as the ai_sdk path. The adapter sees a child abort signal so a
 * throwing on_chunk consumer cancels the in-flight request, and its chunk
 * emissions flow through the shared dispatcher, which is what lets
 * run_tool_loop treat both transports identically.
 */
function build_native_invoke(cfg: NativeInvokeConfig): InvokeOnce {
  const classify = cfg.adapter.classify_error ?? classify_provider_error
  return async (args: InvokeOnceArgs): Promise<TurnResult> => {
    let chunks_started = false
    const call_once = async (turn_abort: AbortSignal): Promise<TurnResult> => {
      // turn_abort is the composed user-abort + turn_timeout deadline; the
      // internal controller adds one more reason to cancel (a throwing chunk
      // consumer) without losing either of those.
      const internal_controller = new AbortController()
      const cancel_on_turn_abort = (): void => {
        internal_controller.abort(turn_abort.reason)
      }
      if (turn_abort.aborted) {
        internal_controller.abort(turn_abort.reason)
      } else {
        turn_abort.addEventListener('abort', cancel_on_turn_abort, { once: true })
      }
      const dispatch_chunk = async (chunk: StreamChunk): Promise<void> => {
        chunks_started = true
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
        stream: args.stream,
        model_id: cfg.model_id,
        effort: cfg.effort,
        ...(system !== undefined ? { system } : {}),
        ...(cfg.schema !== undefined ? { schema: cfg.schema } : {}),
        ...(cfg.provider_options !== undefined
          ? { provider_options: cfg.provider_options }
          : {}),
        ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
        ...(cfg.max_tokens !== undefined ? { max_tokens: cfg.max_tokens } : {}),
        ...(cfg.top_p !== undefined ? { top_p: cfg.top_p } : {}),
        ...(args.stream ? { dispatch_chunk } : {}),
      }
      try {
        return await cfg.adapter.invoke_turn(req)
      } finally {
        turn_abort.removeEventListener('abort', cancel_on_turn_abort)
      }
    }

    return await retry_turn(
      call_once,
      args,
      () => chunks_started,
      cfg.retry_policy,
      classify,
      cfg.turn_timeout_ms,
    )
  }
}

export async function generate<T = string>(
  opts_in: GenerateOptions<T>,
  engine: EngineInternals,
): Promise<GenerateResult<T>> {
  if (opts_in.abort?.aborted === true) {
    throw new aborted_error('aborted', { reason: opts_in.abort.reason })
  }

  const resolved_model = opts_in.model ?? engine.default_model
  if (resolved_model === undefined) throw new model_required_error()
  const sole_provider =
    engine.adapters.size === 1 ? [...engine.adapters.keys()][0] : undefined
  const resolved_provider =
    opts_in.provider ?? engine.default_provider ?? sole_provider ?? 'anthropic'

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
  if (merged_provider_options !== undefined) {
    opts.provider_options = merged_provider_options
  }

  const target: ResolvedModel = { provider: resolved_provider, model_id: resolved_model }

  const adapter = engine.adapters.get(target.provider)
  if (adapter === undefined) {
    throw new provider_not_configured_error(target.provider)
  }

  if (adapter.kind === 'external') {
    return adapter.generate<T>(opts, target)
  }

  // Stamp engine events with `ts` when generate is called directly with a
  // caller-supplied logger. A runner-decorated logger already carries `ts`;
  // with_timestamps preserves it.
  const trajectory = with_timestamps(opts.trajectory)
  const on_chunk_provided = opts.on_chunk !== undefined
  const tools_list: ReadonlyArray<Tool> = opts.tools ?? []

  if (opts.schema !== undefined && !adapter.supports('schema')) {
    throw new provider_capability_error(target.provider, 'schema')
  }
  if (tools_list.length > 0 && !adapter.supports('tools')) {
    throw new provider_capability_error(target.provider, 'tools')
  }
  if (on_chunk_provided && !adapter.supports('streaming')) {
    throw new provider_capability_error(target.provider, 'streaming')
  }

  const effort: EffortLevel = opts.effort ?? engine.default_effort
  const retry_policy = opts.retry ?? engine.default_retry
  const turn_timeout_ms = opts.turn_timeout_ms ?? engine.default_turn_timeout_ms
  if (turn_timeout_ms !== undefined && turn_timeout_ms <= 0) {
    // A zero/negative budget would fire the deadline before the request even
    // starts; reject rather than silently disable or hang.
    throw new engine_config_error('turn_timeout_ms must be > 0')
  }
  const dispatcher = create_chunk_dispatcher(opts.on_chunk)

  let invoke_once: InvokeOnce
  if (adapter.kind === 'ai_sdk') {
    const effort_translation = adapter.translate_effort(effort)
    if (effort !== 'none' && effort_translation.effort_ignored) {
      record_effort_ignored(trajectory, target.model_id)
    }
    // Effort translation is the lowest-precedence layer; engine defaults and
    // per-call provider_options (already merged into opts.provider_options, with
    // per-call winning) override it. Without this merge the user's provider_options
    // were computed then dropped, a silent no-op for every provider.
    const combined_provider_options = merge_provider_options(
      effort_translation.provider_options,
      opts.provider_options,
    )
    const provider_options =
      combined_provider_options !== undefined &&
      Object.keys(combined_provider_options).length > 0
        ? combined_provider_options
        : undefined

    // All SDK specifics (message/tool mapping, Output.object structured-output
    // gating, the generateText/streamText call) live behind create_ai_sdk_turn;
    // this branch only threads resolved options through the seam.
    invoke_once = build_ai_sdk_invoke({
      invoke_turn: create_ai_sdk_turn({
        adapter,
        model_id: target.model_id,
        dispatcher,
        tools: tools_list,
        schema: opts.schema,
        // The merge produces the two-level per-provider shape the seam
        // declares; the merged value is typed loosely upstream.
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        provider_options: provider_options as AiSdkTurnConfig['provider_options'],
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        top_p: opts.top_p,
      }),
      retry_policy,
      turn_timeout_ms,
    })
  } else {
    // No effort translation here: a native adapter receives the resolved
    // effort level on TurnRequest and owns its own mapping, so
    // provider_options stays the plain defaults + per-call merge.
    invoke_once = build_native_invoke({
      adapter,
      model_id: target.model_id,
      retry_policy,
      turn_timeout_ms,
      dispatcher,
      effort,
      schema: opts.schema,
      // The merge produces the two-level per-provider shape TurnRequest
      // declares; GenerateOptions types it loosely as Record<string, unknown>.
      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      provider_options: opts.provider_options as TurnRequest['provider_options'],
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
      top_p: opts.top_p,
    })
  }

  const abort = opts.abort ?? new AbortController().signal
  const max_steps = opts.max_steps ?? engine.default_max_steps
  const tool_error_policy =
    opts.tool_error_policy ?? engine.default_tool_error_policy ?? 'feed_back'
  const schema_repair_attempts =
    opts.schema_repair_attempts ?? engine.default_schema_repair_attempts ?? 1
  const tool_call_repair_attempts =
    opts.tool_call_repair_attempts ?? engine.default_tool_call_repair_attempts ?? 0
  if (tool_call_repair_attempts < 0) {
    throw new engine_config_error('tool_call_repair_attempts must be >= 0')
  }
  const max_tool_calls_per_step =
    opts.max_tool_calls_per_step ?? engine.default_max_tool_calls_per_step
  if (max_tool_calls_per_step !== undefined && max_tool_calls_per_step < 1) {
    // A cap of 0 would drop every call and strand the loop in its stop
    // branch with orphaned records; reject rather than guess.
    throw new engine_config_error('max_tool_calls_per_step must be >= 1')
  }

  const schema_prefix =
    opts.schema !== undefined
      ? 'You must respond with a single JSON value that conforms to the expected schema. Return ONLY the JSON value, with no markdown or commentary.'
      : undefined
  const initial_messages = build_initial_messages(opts)
  if (schema_prefix !== undefined) {
    const idx = initial_messages.findIndex((m) => m.role === 'system')
    if (idx >= 0) {
      const sys = initial_messages[idx]
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

  const generate_span = start_generate_span(trajectory, {
    model: resolved_model,
    provider: target.provider,
    model_id: target.model_id,
    has_tools: tools_list.length > 0,
    has_schema: opts.schema !== undefined,
    streaming: on_chunk_provided,
  })

  const pricing_dedup = create_pricing_missing_dedup(trajectory)

  const resolve_pricing = (): Pricing | undefined => {
    return engine.pricing[pricing_key(target.provider, target.model_id)]
  }

  const dispatch_chunk =
    on_chunk_provided
      ? async (chunk: StreamChunk): Promise<void> => {
          await dispatcher.dispatch(chunk)
        }
      : undefined

  const messages_mutable: Message[] = [...initial_messages]
  let total_steps = 0
  const steps_accum: GenerateResult<T>['steps'] = []
  const tool_calls_accum: GenerateResult<T>['tool_calls'] = []
  let text = ''
  let finish_reason: FinishReason = 'stop'
  let repair_remaining = schema_repair_attempts
  let content_parsed: T | undefined
  let schema_satisfied = opts.schema === undefined
  // One holder per generate call so schema-repair re-invocations of the loop
  // cannot refill the salvage budget.
  const salvage_budget =
    tool_call_repair_attempts > 0 ? { remaining: tool_call_repair_attempts } : undefined

  try {
    while (true) {
      const loop_result = await run_tool_loop({
        invoke_once,
        messages: messages_mutable,
        tools: tools_list,
        max_steps,
        step_index_start: total_steps,
        tool_error_policy,
        abort,
        on_tool_approval: opts.on_tool_approval,
        trajectory,
        stream: on_chunk_provided,
        dispatch_chunk,
        provider: target.provider,
        model_id: target.model_id,
        resolve_pricing,
        pricing_dedup,
        ...(salvage_budget !== undefined ? { salvage_budget } : {}),
        ...(max_tool_calls_per_step !== undefined ? { max_tool_calls_per_step } : {}),
        ...(opts.prepare_step !== undefined ? { prepare_step: opts.prepare_step } : {}),
      })

      for (const s of loop_result.steps) steps_accum.push(s)
      for (const tc of loop_result.tool_calls) tool_calls_accum.push(tc)
      total_steps = steps_accum.length
      text = loop_result.text
      finish_reason = loop_result.finish_reason

      if (opts.schema === undefined) break
      if (finish_reason !== 'stop') break

      const parse = parse_with_schema(opts.schema, text)
      if (parse.ok) {
        content_parsed = parse.value
        schema_satisfied = true
        break
      }
      record_schema_validation_failed(trajectory, {
        attempt: repair_remaining === schema_repair_attempts ? 'initial' : 'repair',
        zod_issues: format_zod_error(parse.error),
        raw_text: text,
      })
      if (repair_remaining <= 0 || total_steps >= max_steps) {
        throw_schema_validation(parse.error, text)
      }
      repair_remaining -= 1
      messages_mutable.push(build_repair_message(parse.error))
    }

    const aggregated_usage = sum_usage(steps_accum)
    const aggregated_cost = aggregate_cost(steps_accum, target.provider)

    let final_content: T
    if (opts.schema === undefined) {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      final_content = text as T
    } else if (schema_satisfied && content_parsed !== undefined) {
      final_content = content_parsed
    } else {
      // Unreachable: if schema set and not satisfied we throw above.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      final_content = text as T
    }

    const result: GenerateResult<T> = {
      content: final_content,
      tool_calls: tool_calls_accum,
      steps: steps_accum,
      usage: aggregated_usage,
      finish_reason,
      model_resolved: { provider: target.provider, model_id: target.model_id },
    }
    if (aggregated_cost !== undefined) result.cost = aggregated_cost

    if (on_chunk_provided) {
      await dispatcher.dispatch({
        kind: 'finish',
        finish_reason,
        usage: aggregated_usage,
      })
    }

    end_generate_span(trajectory, generate_span, {
      usage: aggregated_usage,
      finish_reason,
      model_resolved: result.model_resolved,
    })
    return result
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    end_generate_span(trajectory, generate_span, { error: message })
    throw err
  }
}

export function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

export function aggregate_cost(
  steps: ReadonlyArray<GenerateResult['steps'][number]>,
  provider: string,
): CostBreakdown | undefined {
  let any_present = false
  let total = 0
  let input = 0
  let output = 0
  let cached_present = false
  let cached = 0
  let cache_write_present = false
  let cache_write = 0
  let reasoning_present = false
  let reasoning = 0
  for (const s of steps) {
    if (s.cost === undefined) continue
    any_present = true
    total += s.cost.total_usd
    input += s.cost.input_usd
    output += s.cost.output_usd
    if (s.cost.cached_input_usd !== undefined) {
      cached_present = true
      cached += s.cost.cached_input_usd
    }
    if (s.cost.cache_write_usd !== undefined) {
      cache_write_present = true
      cache_write += s.cost.cache_write_usd
    }
    if (s.cost.reasoning_usd !== undefined) {
      reasoning_present = true
      reasoning += s.cost.reasoning_usd
    }
  }
  if (!any_present) {
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
    total_usd: round6(total),
    input_usd: round6(input),
    output_usd: round6(output),
    currency: 'USD',
    is_estimate: true,
  }
  if (cached_present) out.cached_input_usd = round6(cached)
  if (cache_write_present) out.cache_write_usd = round6(cache_write)
  if (reasoning_present) out.reasoning_usd = round6(reasoning)
  return out
}

