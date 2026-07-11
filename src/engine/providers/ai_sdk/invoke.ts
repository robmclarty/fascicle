/**
 * The ai_sdk transport: the engine's only Vercel AI SDK call site.
 *
 * Invariant 13 (constraints §7, inverted): only this module imports from `ai`
 * or invokes generateText / streamText. generate.ts drives this transport
 * through create_ai_sdk_turn and stays SDK-agnostic; run_tool_loop sees the
 * same neutral TurnResult a native adapter produces. Rule-enforced by
 * rules/no-ai-import-outside-ai-sdk-provider.yml.
 *
 * Retry stays out of this module on purpose (D5): generate.ts wraps the turn
 * returned here in the engine-owned retry_turn, exactly as it wraps a native
 * adapter's invoke_turn. This module owns request/response mapping only.
 */

import {
  generateText,
  NoObjectGeneratedError,
  Output,
  isStepCount,
  streamText,
  tool as ai_tool,
  type LanguageModel,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from 'ai'
import type { z } from 'zod'
import type {
  AiSdkTelemetrySettings,
  FinishReason,
  Message,
  StreamChunk,
  Tool,
  TurnResult,
  UsageTotals,
} from '../../types.js'
import { aborted_error } from '../../errors.js'
import type { ChunkDispatcher } from '../../streaming.js'
import type { RawToolCall } from '../../tool_loop.js'
import {
  default_normalize_usage,
  type AiSdkProviderAdapter,
  type RawProviderUsage,
} from '../types.js'
import { build_ai_sdk_telemetry, type AiSdkTelemetryPassthrough } from './telemetry.js'

export function map_finish_reason(raw: string | undefined): FinishReason {
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

export function to_raw_provider_usage(usage: unknown): RawProviderUsage {
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

export function to_sdk_messages(messages: ReadonlyArray<Message>): ModelMessage[] {
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

/**
 * Hoist a leading run of system messages out of the SDK message list into the
 * AI SDK's top-level `system` option.
 *
 * Passing a `role: 'system'` entry inside `messages` makes the AI SDK treat it
 * as potentially attacker-controlled: it warns on every call (and newer `ai`
 * versions throw unless `allowSystemInMessages` is set). fascicle's system
 * content is the developer's own prompt, and the SDK's own recommendation is to
 * deliver it through the top-level `instructions` option (v7's rename of the
 * former `system` option), which removes the warning at its source rather than
 * suppressing it.
 *
 * Only the *leading* run is hoisted (fascicle's only shape: one or more system
 * messages, then the conversation). A system message that appears after a
 * non-system message keeps its position rather than being silently reordered to
 * the top, and the original list is returned untouched when hoisting would leave
 * `messages` empty, since the SDK rejects an empty messages array.
 */
export function split_leading_system(messages: ReadonlyArray<ModelMessage>): {
  system?: string
  messages: ModelMessage[]
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

export function to_sdk_tools(tools: ReadonlyArray<Tool>): ToolSet | undefined {
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

export function map_stream_part_to_chunk(
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
      // v7 parts with no engine StreamChunk kind (file, reasoning-file,
      // source, block framing) drop here on purpose: the engine models
      // text, reasoning, and tool traffic, not generated files.
      return undefined
  }
}

export function default_usage_from_sdk(usage: unknown): UsageTotals {
  // Streamed step_finish chunks must carry the same cache/reasoning
  // granularity the step record gets via adapter.normalize_usage; every
  // built-in adapter routes through default_normalize_usage, so this keeps
  // the chunk surface consistent with the non-streamed result.
  return default_normalize_usage(to_raw_provider_usage(usage))
}

async function collect_stream(
  params: Parameters<typeof streamText>[0],
  step_index: number,
  dispatcher: ChunkDispatcher,
  on_first_chunk: () => void,
  internal_controller: AbortController,
  adapter: AiSdkProviderAdapter,
): Promise<TurnResult> {
  const stream_result = streamText(params)
  let text = ''
  const tool_calls: RawToolCall[] = []
  let finish_reason: FinishReason = 'stop'
  let raw_usage: RawProviderUsage = {}
  let first = true

  for await (const part of stream_result.stream) {
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
): Promise<TurnResult> {
  let result: Awaited<ReturnType<typeof generateText>>
  try {
    result = await generateText(params)
  } catch (err: unknown) {
    const recovered = recover_no_object_generated(err, adapter)
    if (recovered !== undefined) return recovered
    throw err
  }
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

/**
 * When `output` (structured output) is in play, `generateText` eagerly parses the
 * model's text against the schema and throws `NoObjectGeneratedError` if it
 * does not conform. That parse is the SDK's, not fascicle's: turning it into a
 * thrown error would skip the engine's own schema-parse + repair loop (and the
 * error is not a retryable transient, so it would surface raw). Instead we
 * recover the model's raw text from the error and hand it back as a normal
 * turn result, so `parse_with_schema` re-validates it and the repair loop
 * engages exactly as it does for the prompt-based path. Returns undefined for
 * any other error so the caller rethrows.
 */
function recover_no_object_generated(
  err: unknown,
  adapter: AiSdkProviderAdapter,
): TurnResult | undefined {
  if (!NoObjectGeneratedError.isInstance(err)) return undefined
  const text_field = Reflect.get(err, 'text')
  const finish_field = Reflect.get(err, 'finishReason')
  const raw_usage = to_raw_provider_usage(Reflect.get(err, 'usage'))
  return {
    text: typeof text_field === 'string' ? text_field : '',
    tool_calls: [],
    finish_reason: map_finish_reason(typeof finish_field === 'string' ? finish_field : undefined),
    usage: adapter.normalize_usage(raw_usage),
  }
}

type AiSdkCallParams = Parameters<typeof streamText>[0] & Parameters<typeof generateText>[0]

export type AiSdkTurnConfig = {
  readonly adapter: AiSdkProviderAdapter
  readonly model_id: string
  readonly dispatcher: ChunkDispatcher
  readonly tools: ReadonlyArray<Tool>
  readonly schema: z.ZodType | undefined
  readonly provider_options: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined
  readonly temperature: number | undefined
  readonly max_tokens: number | undefined
  readonly top_p: number | undefined
  readonly telemetry: AiSdkTelemetrySettings | undefined
}

export type AiSdkTurnArgs = {
  readonly step_index: number
  readonly messages: ReadonlyArray<Message>
  readonly abort: AbortSignal
  readonly stream: boolean
  readonly on_first_chunk: () => void
}

export type AiSdkTurn = (args: AiSdkTurnArgs) => Promise<TurnResult>

/**
 * Build the single-attempt SDK turn for one generate call: the
 * generateText/streamText call body behind the same neutral seam a native
 * adapter's invoke_turn implements. The built model is memoized across steps
 * of one generate call. No retry here: generate.ts wraps the returned turn in
 * the engine-owned retry_turn.
 */
export function create_ai_sdk_turn(cfg: AiSdkTurnConfig): AiSdkTurn {
  let model_instance: LanguageModel | undefined
  const get_model = async (): Promise<LanguageModel> => {
    if (model_instance === undefined) {
      const built = await cfg.adapter.build_model(cfg.model_id)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      model_instance = built as LanguageModel
    }
    return model_instance
  }

  // Telemetry is resolved once per generate call and memoized across its steps,
  // mirroring get_model. build_ai_sdk_telemetry returns undefined immediately
  // (no peer load) unless telemetry is explicitly enabled, so the disabled
  // default costs nothing.
  let telemetry_options: AiSdkTelemetryPassthrough | undefined
  let telemetry_resolved = false
  const get_telemetry = async (): Promise<AiSdkTelemetryPassthrough | undefined> => {
    if (!telemetry_resolved) {
      telemetry_options = await build_ai_sdk_telemetry(cfg.telemetry)
      telemetry_resolved = true
    }
    return telemetry_options
  }

  const sdk_tools = to_sdk_tools(cfg.tools)

  // Native structured output: when a schema is requested and the provider
  // constrains decoding to it (the 'structured_output' capability), route
  // through the AI SDK's Output.object seam so the schema becomes the
  // provider's responseFormat (e.g. Ollama's `format`) instead of a
  // prompt-for-JSON-then-scrape. Gated on no tools: forcing a JSON
  // responseFormat alongside tool calls breaks tool dispatch on most
  // providers, so tool runs keep the prompt-based schema path. The engine's
  // schema parse + repair loop still owns validation either way. This seam
  // is ai_sdk-only: a native adapter that constrains decoding honors
  // TurnRequest.schema inside its own invoke_turn.
  let output_spec: NonNullable<AiSdkCallParams['output']> | undefined
  if (
    cfg.schema !== undefined &&
    cfg.tools.length === 0 &&
    cfg.adapter.supports('structured_output')
  ) {
    // Output.object<T> is not structurally assignable to the SDK's default
    // Output<string, string> param slot, but the runtime shape is exactly
    // what generateText/streamText consume to set responseFormat.
    // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    output_spec = Output.object({ schema: cfg.schema }) as NonNullable<
      AiSdkCallParams['output']
    >
  }

  // provider_options is Record<string, Record<string, unknown>>; the SDK
  // expects SharedV3ProviderOptions (Record<string, JSONObject>) which is
  // structurally compatible for our usage.
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const provider_options = cfg.provider_options as AiSdkCallParams['providerOptions']

  return async (args: AiSdkTurnArgs): Promise<TurnResult> => {
    const model = await get_model()
    const telemetry = await get_telemetry()
    const internal_controller = new AbortController()
    const cancel_on_user_abort = (): void => {
      internal_controller.abort(args.abort.reason)
    }
    if (args.abort.aborted) {
      internal_controller.abort(args.abort.reason)
    } else {
      args.abort.addEventListener('abort', cancel_on_user_abort, { once: true })
    }
    const { system: hoisted_system, messages: sdk_messages } = split_leading_system(
      to_sdk_messages(args.messages),
    )
    const base_params: AiSdkCallParams = {
      model,
      messages: sdk_messages,
      abortSignal: internal_controller.signal,
      stopWhen: isStepCount(1),
      // The engine owns retry via retry_turn in generate.ts; disable the AI
      // SDK's own retry (default 2) so it does not nest inside each of our
      // attempts and inflate provider round-trips / distort backoff.
      maxRetries: 0,
    }
    if (hoisted_system !== undefined) base_params.instructions = hoisted_system
    if (sdk_tools !== undefined) base_params.tools = sdk_tools
    if (output_spec !== undefined) base_params.output = output_spec
    if (provider_options !== undefined) base_params.providerOptions = provider_options
    if (cfg.temperature !== undefined) base_params.temperature = cfg.temperature
    if (cfg.max_tokens !== undefined) base_params.maxOutputTokens = cfg.max_tokens
    if (cfg.top_p !== undefined) base_params.topP = cfg.top_p
    if (telemetry !== undefined) {
      // AiSdkTelemetryPassthrough uses the SDK's own telemetry keys; the slot's
      // generic (RUNTIME_CONTEXT/TOOLS) is erased for our usage.
      // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      base_params.experimental_telemetry = telemetry as NonNullable<
        AiSdkCallParams['experimental_telemetry']
      >
    }

    try {
      if (args.stream) {
        return await collect_stream(
          base_params,
          args.step_index,
          cfg.dispatcher,
          args.on_first_chunk,
          internal_controller,
          cfg.adapter,
        )
      }
      return await collect_non_stream(base_params, cfg.adapter)
    } finally {
      args.abort.removeEventListener('abort', cancel_on_user_abort)
    }
  }
}
