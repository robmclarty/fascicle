/**
 * generate(opts) — single public entry point for model calls.
 *
 * This file owns the `ai` SDK boundary for the engine: only generate.ts,
 * tool_loop.ts, and index.ts are permitted to call generateText / streamText
 * directly (constraints §7 invariant 13). tool_loop.ts consumes the InvokeOnce
 * seam built here.
 */

import {
  generateText,
  stepCountIs,
  streamText,
  tool as ai_tool,
  type LanguageModel,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from 'ai'
import type {
  AliasTable,
  CostBreakdown,
  EffortLevel,
  FinishReason,
  GenerateOptions,
  GenerateResult,
  Message,
  Pricing,
  PricingTable,
  RetryPolicy,
  StreamChunk,
  Tool,
  UsageTotals,
} from './types.js'
import {
  aborted_error,
  engine_config_error,
  on_chunk_error,
  provider_capability_error,
  provider_error,
  provider_not_configured_error,
} from './errors.js'
import { resolve_model } from './aliases.js'
import { merge_provider_options } from './merge_defaults.js'
import { FREE_PROVIDERS, pricing_key } from './pricing.js'
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
  create_pricing_missing_dedup,
  end_generate_span,
  record_effort_ignored,
  start_generate_span,
} from './trajectory.js'
import { sum_usage } from './usage.js'
import {
  run_tool_loop,
  type InvokeOnce,
  type InvokeOnceArgs,
  type InvokeOnceResult,
  type RawToolCall,
} from './tool_loop.js'
import type {
  AiSdkProviderAdapter,
  ProviderAdapter,
  RawProviderUsage,
} from './providers/types.js'

export type EngineInternals = {
  readonly aliases: AliasTable
  readonly pricing: PricingTable
  readonly adapters: ReadonlyMap<string, ProviderAdapter>
  readonly default_retry: RetryPolicy
  readonly default_effort: EffortLevel
  readonly default_max_steps: number
  readonly default_model?: string
  readonly default_system?: string
  readonly default_tool_error_policy?: 'feed_back' | 'throw'
  readonly default_schema_repair_attempts?: number
  readonly default_provider_options?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

function build_initial_messages<T>(opts: GenerateOptions<T>): Message[] {
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

function map_finish_reason(raw: string | undefined): FinishReason {
  switch (raw) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'content-filter':
    case 'content_filter':
      return 'content_filter'
    case 'tool-calls':
    case 'tool_calls':
      return 'tool_calls'
    default:
      return 'stop'
  }
}

function to_raw_provider_usage(usage: unknown): RawProviderUsage {
  if (usage === null || typeof usage !== 'object') return {}
  const raw: RawProviderUsage = {}
  const input_tokens = Reflect.get(usage, 'inputTokens')
  if (typeof input_tokens === 'number') raw.input_tokens = input_tokens
  const output_tokens = Reflect.get(usage, 'outputTokens')
  if (typeof output_tokens === 'number') raw.output_tokens = output_tokens
  const input_details = Reflect.get(usage, 'inputTokenDetails')
  if (input_details !== null && typeof input_details === 'object') {
    const cache_read = Reflect.get(input_details, 'cacheReadTokens')
    const cache_write = Reflect.get(input_details, 'cacheWriteTokens')
    raw.input_token_details = {}
    if (typeof cache_read === 'number') raw.input_token_details.cached_tokens = cache_read
    if (typeof cache_write === 'number') raw.input_token_details.cache_creation_input_tokens = cache_write
  }
  const output_details = Reflect.get(usage, 'outputTokenDetails')
  if (output_details !== null && typeof output_details === 'object') {
    const reasoning = Reflect.get(output_details, 'reasoningTokens')
    raw.output_token_details = {}
    if (typeof reasoning === 'number') raw.output_token_details.reasoning_tokens = reasoning
  }
  // Passthrough for mocks that provide flattened fields directly.
  const cached_flat = Reflect.get(usage, 'cached_input_tokens')
  if (typeof cached_flat === 'number') raw.cached_input_tokens = cached_flat
  const cache_write_flat = Reflect.get(usage, 'cache_write_tokens')
  if (typeof cache_write_flat === 'number') raw.cache_write_tokens = cache_write_flat
  const reasoning_flat = Reflect.get(usage, 'reasoning_tokens')
  if (typeof reasoning_flat === 'number') raw.reasoning_tokens = reasoning_flat
  const input_flat = Reflect.get(usage, 'input_tokens')
  if (raw.input_tokens === undefined && typeof input_flat === 'number') raw.input_tokens = input_flat
  const output_flat = Reflect.get(usage, 'output_tokens')
  if (raw.output_tokens === undefined && typeof output_flat === 'number') raw.output_tokens = output_flat
  return raw
}

function to_sdk_messages(messages: ReadonlyArray<Message>): ModelMessage[] {
  const out: ModelMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content })
      continue
    }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content })
      } else {
        const parts: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; image: string | Uint8Array; mediaType?: string }
        > = m.content.map((p) => {
          if (p.type === 'text') return { type: 'text', text: p.text }
          const image_part: { type: 'image'; image: string | Uint8Array; mediaType?: string } = {
            type: 'image',
            image: p.image,
          }
          if (p.media_type !== undefined) image_part.mediaType = p.media_type
          return image_part
        })
        out.push({ role: 'user', content: parts })
      }
      continue
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: m.tool_call_id,
            toolName: m.name,
            output: { type: 'text', value: m.content },
          },
        ],
      })
      continue
    }
    // assistant
    if (typeof m.content === 'string') {
      out.push({ role: 'assistant', content: m.content })
      continue
    }
    const parts = m.content.map((p) => {
      if (p.type === 'text') return { type: 'text' as const, text: p.text }
      return {
        type: 'tool-call' as const,
        toolCallId: p.id,
        toolName: p.name,
        input: p.input,
      }
    })
    out.push({ role: 'assistant', content: parts })
  }
  return out
}

function to_sdk_tools(tools: ReadonlyArray<Tool>): ToolSet | undefined {
  if (tools.length === 0) return undefined
  const entries: ToolSet = {}
  for (const t of tools) {
    entries[t.name] = ai_tool({
      description: t.description,
      inputSchema: t.input_schema,
    })
  }
  return entries
}

function map_stream_part_to_chunk(
  part: TextStreamPart<ToolSet>,
  step_index: number,
): StreamChunk | undefined {
  switch (part.type) {
    case 'text-delta':
      return { kind: 'text', text: part.text, step_index }
    case 'reasoning-delta':
      return { kind: 'reasoning', text: part.text, step_index }
    case 'tool-input-start':
      return {
        kind: 'tool_call_start',
        id: part.id,
        name: part.toolName,
        step_index,
      }
    case 'tool-input-delta':
      return {
        kind: 'tool_call_input_delta',
        id: part.id,
        delta: part.delta,
        step_index,
      }
    case 'tool-call':
      return {
        kind: 'tool_call_end',
        id: part.toolCallId,
        input: part.input,
        step_index,
      }
    case 'finish-step':
      return {
        kind: 'step_finish',
        step_index,
        finish_reason: map_finish_reason(part.finishReason),
        usage: default_usage_from_sdk(part.usage),
      }
    default:
      return undefined
  }
}

function default_usage_from_sdk(usage: unknown): UsageTotals {
  const raw = to_raw_provider_usage(usage)
  return {
    input_tokens: raw.input_tokens ?? 0,
    output_tokens: raw.output_tokens ?? 0,
  }
}

async function collect_stream(
  params: Parameters<typeof streamText>[0],
  step_index: number,
  dispatcher: ChunkDispatcher,
  on_first_chunk: () => void,
  internal_controller: AbortController,
  adapter: AiSdkProviderAdapter,
): Promise<InvokeOnceResult> {
  const stream_result = streamText(params)
  let text = ''
  const tool_calls: RawToolCall[] = []
  let finish_reason: FinishReason = 'stop'
  let raw_usage: RawProviderUsage = {}
  let first = true

  for await (const part of stream_result.fullStream) {
    if (first) {
      first = false
      on_first_chunk()
    }
    if (part.type === 'text-delta') {
      text += part.text
    }
    if (part.type === 'tool-call') {
      tool_calls.push({
        id: part.toolCallId,
        name: part.toolName,
        input: part.input,
      })
    }
    if (part.type === 'finish-step') {
      finish_reason = map_finish_reason(part.finishReason)
      raw_usage = to_raw_provider_usage(part.usage)
    }
    if (part.type === 'error') {
      throw part.error
    }
    if (part.type === 'abort') {
      throw new aborted_error('aborted', { step_index })
    }
    const chunk = map_stream_part_to_chunk(part, step_index)
    if (chunk === undefined) continue
    try {
      await dispatcher.dispatch(chunk)
    } catch (err: unknown) {
      internal_controller.abort()
      throw err
    }
  }

  return {
    text,
    tool_calls,
    finish_reason,
    usage: adapter.normalize_usage(raw_usage),
  }
}

async function collect_non_stream(
  params: Parameters<typeof generateText>[0],
  adapter: AiSdkProviderAdapter,
): Promise<InvokeOnceResult> {
  const result = await generateText(params)
  const tool_calls: RawToolCall[] = []
  for (const tc of result.toolCalls) {
    tool_calls.push({
      id: tc.toolCallId,
      name: tc.toolName,
      input: tc.input,
    })
  }
  const raw_usage = to_raw_provider_usage(result.usage)
  return {
    text: result.text,
    tool_calls,
    finish_reason: map_finish_reason(result.finishReason),
    usage: adapter.normalize_usage(raw_usage),
  }
}

function classify_ai_sdk_error(err: unknown): unknown {
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

export async function generate<T = string>(
  opts_in: GenerateOptions<T>,
  engine: EngineInternals,
): Promise<GenerateResult<T>> {
  if (opts_in.abort?.aborted === true) {
    throw new aborted_error('aborted', { reason: opts_in.abort.reason })
  }

  const resolved_model = opts_in.model ?? engine.default_model
  if (resolved_model === undefined) {
    throw new engine_config_error(
      'model is required: pass `model` on generate()/model_call() or set `defaults.model` on create_engine',
    )
  }

  const merged_provider_options = merge_provider_options(
    engine.default_provider_options,
    opts_in.provider_options,
  )

  const opts: GenerateOptions<T> = {
    ...opts_in,
    model: resolved_model,
  }
  if (opts_in.system === undefined && engine.default_system !== undefined) {
    opts.system = engine.default_system
  }
  if (merged_provider_options !== undefined) {
    opts.provider_options = merged_provider_options
  }

  const target = resolve_model(engine.aliases, resolved_model)

  const adapter = engine.adapters.get(target.provider)
  if (adapter === undefined) {
    throw new provider_not_configured_error(target.provider)
  }

  if (adapter.kind === 'subprocess') {
    return adapter.generate<T>(opts, target)
  }

  const trajectory = opts.trajectory
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
  const effort_translation = adapter.translate_effort(effort)
  if (effort !== 'none' && effort_translation.effort_ignored) {
    record_effort_ignored(trajectory, target.model_id)
  }
  const provider_options =
    Object.keys(effort_translation.provider_options).length > 0
      ? effort_translation.provider_options
      : undefined

  const abort = opts.abort ?? new AbortController().signal
  const max_steps = opts.max_steps ?? engine.default_max_steps
  const tool_error_policy =
    opts.tool_error_policy ?? engine.default_tool_error_policy ?? 'feed_back'
  const schema_repair_attempts =
    opts.schema_repair_attempts ?? engine.default_schema_repair_attempts ?? 1
  const retry_policy = opts.retry ?? engine.default_retry

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
  const dispatcher = create_chunk_dispatcher(opts.on_chunk)

  const resolve_pricing = (): Pricing | undefined => {
    return engine.pricing[pricing_key(target.provider, target.model_id)]
  }

  let model_instance: LanguageModel | undefined
  const get_model = async (): Promise<LanguageModel> => {
    if (model_instance === undefined) {
      const built = await adapter.build_model(target.model_id)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      model_instance = built as LanguageModel
    }
    return model_instance
  }

  const sdk_tools = to_sdk_tools(tools_list)

  const invoke_once: InvokeOnce = async (args: InvokeOnceArgs): Promise<InvokeOnceResult> => {
    let chunks_started = false
    const call_once = async (): Promise<InvokeOnceResult> => {
      const model = await get_model()
      const internal_controller = new AbortController()
      const cancel_on_user_abort = (): void => {
        internal_controller.abort(args.abort.reason)
      }
      if (args.abort.aborted) {
        internal_controller.abort(args.abort.reason)
      } else {
        args.abort.addEventListener('abort', cancel_on_user_abort, { once: true })
      }
      const base_params: Parameters<typeof streamText>[0] & Parameters<typeof generateText>[0] = {
        model,
        messages: to_sdk_messages(args.messages),
        abortSignal: internal_controller.signal,
        stopWhen: stepCountIs(1),
      }
      if (sdk_tools !== undefined) base_params.tools = sdk_tools
      if (provider_options !== undefined) {
        // provider_options is Record<string, Record<string, unknown>>; the SDK
        // expects SharedV3ProviderOptions (Record<string, JSONObject>) which is
        // structurally compatible for our usage.
        // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        base_params.providerOptions = provider_options as NonNullable<typeof base_params.providerOptions>
      }
      if (opts.temperature !== undefined) base_params.temperature = opts.temperature
      if (opts.max_tokens !== undefined) base_params.maxOutputTokens = opts.max_tokens
      if (opts.top_p !== undefined) base_params.topP = opts.top_p
      
      try {
        if (args.stream) {
          return await collect_stream(
            base_params,
            args.step_index,
            dispatcher,
            () => {
              chunks_started = true
            },
            internal_controller,
            adapter,
          )
        }
        return await collect_non_stream(base_params, adapter)
      } finally {
        args.abort.removeEventListener('abort', cancel_on_user_abort)
      }
    }
  
    return await retry_with_policy(
      async () => {
        try {
          return await call_once()
        } catch (err: unknown) {
          if (err instanceof on_chunk_error) throw err
          if (err instanceof aborted_error) throw err
          if (args.abort.aborted) {
            throw new aborted_error('aborted', {
              reason: args.abort.reason,
              step_index: args.step_index,
            })
          }
          if (chunks_started) {
            const message = err instanceof Error ? err.message : String(err)
            throw new provider_error(`stream interrupted: ${message}`, {
              cause_kind: 'unknown',
            })
          }
          throw classify_ai_sdk_error(err)
        }
      },
      retry_policy,
      args.abort,
    )
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

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

function aggregate_cost(
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

