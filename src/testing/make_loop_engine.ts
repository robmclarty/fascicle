/**
 * make_loop_engine: a scripted model under the engine's own tool loop.
 *
 * make_stub_engine, make_script_engine, and make_capture_engine replace the
 * whole engine, so no tool runs under them. This double registers a native
 * provider through `create_engine` instead, and the real engine runs its
 * loop around a script: each time the loop asks the model for a turn, the
 * script plays its next entry, and the engine runs the tools, asks for the
 * approvals, and feeds the results back as it would around a real model.
 * Every request the model was sent lands in `requests` before its turn
 * plays, so a test reads what the loop sent, tool results included.
 *
 * A turn is a string (a final answer), an array of calls (a tool-calling
 * turn), or an object that spells the turn out field by field or throws
 * instead of answering. The engine classifies a thrown error as it would a
 * provider's, so a retryable one uses up the next turn on its retry, while
 * a plain `Error` never retries. A turn past the end of the script throws,
 * naming how many turns were scripted.
 *
 * The engine registers no pricing, so a call with a trajectory records
 * `pricing_missing`.
 */

import { create_engine } from '#engine'
import type {
  AssistantContentPart,
  Engine,
  FinishReason,
  NativeProviderAdapter,
  TurnRequest,
  TurnResult,
  UsageTotals,
} from '#engine'
import { DEFAULT_USAGE } from './canned.js'

const PROVIDER = 'loop'

/** One tool call a scripted turn makes. A call without an `id` gets `call_<turn>_<n>`. */
export type LoopCall = {
  readonly id?: string
  readonly name: string
  readonly input: unknown
}

/** A turn spelled out field by field. */
type LoopTurnFields = {
  /** The turn's text (default: its `content`'s text parts, joined). */
  readonly text?: string
  /** The calls the turn makes (default: its `content`'s tool_call parts). */
  readonly tool_calls?: ReadonlyArray<LoopCall>
  /** The turn's parts, which the loop sends back as the assistant message. */
  readonly content?: ReadonlyArray<AssistantContentPart>
  /** Default: `'tool_calls'` when the turn makes calls, `'stop'` otherwise. */
  readonly finish_reason?: FinishReason
  /** Default: the engine's `usage` option. */
  readonly usage?: UsageTotals
  /**
   * True to play a turn the provider paused partway through (Anthropic's
   * `pause_turn`), which the loop sends back and continues with another turn.
   */
  readonly paused?: boolean
  /** An error to throw for this turn instead of answering. */
  readonly throw?: Error
}

/**
 * One model turn: a string is a final answer, an array is the calls the turn
 * makes, and an object spells the turn out field by field.
 */
export type LoopTurn = string | ReadonlyArray<LoopCall> | LoopTurnFields

export type LoopEngineOptions = {
  /** The model every call resolves to unless it names one (default `'loop'`). */
  readonly model_id?: string
  /** The usage a turn reports when it sets none (default `{ input_tokens: 40, output_tokens: 20 }`). */
  readonly usage?: UsageTotals
  /**
   * The caching the double's provider declares, which decides the `cache`
   * each request carries (default: none, so no request carries one).
   */
  readonly prompt_cache?: NativeProviderAdapter['prompt_cache']
}

export type LoopEngine = {
  readonly engine: Engine
  /** Every request the model was sent, in order, growing as the script plays. */
  readonly requests: TurnRequest[]
}

type NamedCall = { readonly id: string; readonly name: string; readonly input: unknown }

/** Narrow a turn to its array form. */
function is_call_list(turn: LoopTurn): turn is ReadonlyArray<LoopCall> {
  return Array.isArray(turn)
}

/** Read any turn as its object form. */
function as_fields(turn: LoopTurn): LoopTurnFields {
  if (typeof turn === 'string') return { text: turn }
  if (is_call_list(turn)) return { tool_calls: turn }
  return turn
}

/** The turn's text: its own, or its content's text parts joined, or none. */
function text_of_turn(fields: LoopTurnFields): string {
  if (fields.text !== undefined) return fields.text
  return fields.content?.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('') ?? ''
}

/** The turn's calls, its own or its content's, each given an id it lacks. */
function calls_of_turn(fields: LoopTurnFields, position: number): NamedCall[] {
  const calls =
    fields.tool_calls ?? fields.content?.flatMap((part) => (part.type === 'tool_call' ? [part] : [])) ?? []
  return calls.map((call, n) => ({ id: call.id ?? `call_${position}_${n}`, name: call.name, input: call.input }))
}

/**
 * Play one scripted turn the way a native provider streams it: a throw
 * before anything streams, else its text as one chunk and each call's start
 * and then its whole input, and then the aggregated result.
 */
async function play(
  req: TurnRequest,
  fields: LoopTurnFields,
  position: number,
  default_usage: UsageTotals,
): Promise<TurnResult> {
  if (fields.throw !== undefined) throw fields.throw
  const text = text_of_turn(fields)
  const tool_calls = calls_of_turn(fields, position)
  const step_index = req.step_index
  // Stryker disable OptionalChaining: this provider supports streaming, so the engine hands every turn a dispatch_chunk and the guard can't be seen through the engine; it covers a request that carries none.
  if (text !== '') await req.dispatch_chunk?.({ kind: 'text', text, step_index })
  for (const call of tool_calls) {
    await req.dispatch_chunk?.({ kind: 'tool_call_start', id: call.id, name: call.name, step_index })
    await req.dispatch_chunk?.({ kind: 'tool_call_end', id: call.id, input: call.input, step_index })
  }
  // Stryker restore OptionalChaining
  const result: TurnResult = {
    text,
    tool_calls,
    finish_reason: fields.finish_reason ?? (tool_calls.length > 0 ? 'tool_calls' : 'stop'),
    usage: fields.usage ?? default_usage,
    ...(fields.paused === true ? { paused: true } : {}),
  }
  // Stryker disable next-line ConditionalExpression: the loop reads `content: undefined` as no content (`tool_loop.ts` checks `!== undefined`), so always spreading it is unobservable.
  return fields.content === undefined ? result : { ...result, content: fields.content }
}

/**
 * Build an engine whose one provider, `'loop'`, plays `turns` in order, a
 * turn each time any call through the engine asks the model for one, and
 * the array that records every request it was sent.
 *
 * `options.model_id` sets the default model (default `'loop'`),
 * `options.usage` the usage a turn reports when it sets none (default
 * `{ input_tokens: 40, output_tokens: 20 }`), and `options.prompt_cache` the
 * caching its provider declares (default: none).
 */
export function make_loop_engine(
  turns: ReadonlyArray<LoopTurn>,
  options: LoopEngineOptions = {},
): LoopEngine {
  const default_usage = options.usage ?? DEFAULT_USAGE
  const requests: TurnRequest[] = []
  let played = 0
  const engine = create_engine({
    providers: { [PROVIDER]: {} },
    custom_providers: {
      [PROVIDER]: () => ({
        // Stryker disable next-line StringLiteral: generate branches only on 'external' and 'ai_sdk', so any other kind runs as native.
        kind: 'native',
        name: PROVIDER,
        supports: () => true,
        // Stryker disable next-line ConditionalExpression: the engine reads `prompt_cache` as a value, so a key set to undefined reads the same as no key.
        ...(options.prompt_cache !== undefined ? { prompt_cache: options.prompt_cache } : {}),
        invoke_turn: async (req) => {
          requests.push(req)
          const position = played
          played += 1
          const turn = turns[position]
          if (turn === undefined) {
            throw new Error(
              `make_loop_engine: script exhausted: ${turns.length} turn(s) scripted, turn ${played} requested`,
            )
          }
          return await play(req, as_fields(turn), position, default_usage)
        },
      }),
    },
    defaults: { provider: PROVIDER, model: options.model_id ?? PROVIDER },
  })
  return { engine, requests }
}
