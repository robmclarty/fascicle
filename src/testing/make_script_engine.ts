/**
 * make_script_engine: a queue of canned responses consumed in call order.
 *
 * Where make_stub_engine routes by system-prompt prefix and cannot tell
 * call 3 from call 1, a script cares only about order: the first generate
 * call gets the first entry, the second the next, and a call past the end
 * throws naming how many responses were scripted versus received, so a flow
 * that makes an unexpected extra model call fails loudly. That makes it the
 * double for loops that must converge, retry paths, and flows whose calls a
 * prefix cannot distinguish (a markdown-only define_agent sends no system
 * prompt at all, so every call looks alike to a stub).
 *
 * An entry is plain content, or a `ScriptResponse` object when the call
 * should carry tool calls, report a different finish reason or usage, or
 * throw a scripted error (a rate_limit_error, a provider_error) instead of
 * answering. Only an object whose keys ALL belong to the ScriptResponse
 * shape is treated as scripted; any other value, `{ verdict: 'ship' }`
 * included, becomes content as-is. Wrap literal content that collides with
 * the shape in `{ content }`.
 *
 * Scripted content is validated through the caller's schema, and the abort
 * and on_chunk contracts match make_stub_engine's; see ./canned.ts.
 */

import type {
  Engine,
  FinishReason,
  GenerateOptions,
  GenerateResult,
  ToolCallRecord,
  UsageTotals,
} from '#engine'
import { DEFAULT_USAGE, emit_chunks, throw_if_aborted, validate_canned } from './canned.js'
import { engine_from_generate } from './engine_from_generate.js'

export type ScriptResponse = {
  readonly content?: unknown
  readonly tool_calls?: ReadonlyArray<ToolCallRecord>
  readonly finish_reason?: FinishReason
  readonly usage?: UsageTotals
  /** An error to throw for this call instead of answering. */
  readonly throw?: Error
}

export type ScriptEngineOptions = {
  readonly usage?: UsageTotals
  readonly model_id?: string
}

const SCRIPT_KEYS = new Set(['content', 'tool_calls', 'finish_reason', 'usage', 'throw'])

/**
 * Decide whether a queue entry is a ScriptResponse or plain content. Only a
 * non-null, non-array object whose keys all belong to the ScriptResponse
 * shape is scripted, so an arbitrary content fixture with its own keys
 * passes through untouched rather than being half-read as a script entry.
 */
function is_script_response(entry: unknown): entry is ScriptResponse {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
  const keys = Object.keys(entry)
  return keys.length > 0 && keys.every((key) => SCRIPT_KEYS.has(key))
}

/**
 * Build an `Engine` that answers generate calls strictly in call order from
 * `responses`, throwing once the queue is exhausted.
 *
 * `options` mirrors make_stub_engine's: `usage` is the default usage for
 * entries that do not set their own (default `{ input_tokens: 40,
 * output_tokens: 20 }`) and `model_id` sets `model_resolved.model_id`
 * (default `'script'`). The provider always reports as `'stub'`.
 */
export function make_script_engine(
  responses: ReadonlyArray<unknown>,
  options: ScriptEngineOptions = {},
): Engine {
  const default_usage = options.usage ?? DEFAULT_USAGE
  const model_id = options.model_id ?? 'script'
  let call_count = 0

  return engine_from_generate(
    async <t = string>(opts: GenerateOptions<t>): Promise<GenerateResult<t>> => {
      throw_if_aborted(opts.abort)
      call_count += 1
      const index = call_count - 1
      if (index >= responses.length) {
        throw new Error(
          `make_script_engine: script exhausted: ${responses.length} response(s) scripted, call ${call_count} received`,
        )
      }
      const entry = responses[index]
      const scripted: ScriptResponse = is_script_response(entry) ? entry : { content: entry }
      if (scripted.throw !== undefined) throw scripted.throw
      const usage = scripted.usage ?? default_usage
      const finish_reason = scripted.finish_reason ?? 'stop'
      // Chunks carry the raw scripted content, before validation, mirroring a
      // real stream where text flows and only then gets validated.
      await emit_chunks(opts.on_chunk, scripted.content, finish_reason, usage)
      const content = await validate_canned(
        opts.schema,
        scripted.content,
        `make_script_engine: scripted response ${index}`,
      )
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: content as t,
        tool_calls: scripted.tool_calls === undefined ? [] : [...scripted.tool_calls],
        steps: [],
        usage,
        finish_reason,
        model_resolved: { provider: 'stub', model_id },
      }
    },
  )
}
