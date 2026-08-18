/**
 * make_stub_engine: a canned, network-free `Engine` for tests and demos.
 *
 * Each generate call is routed by the system prompt's stable first line:
 * the first canned response whose `prefix` the system prompt starts with
 * answers the call, and an unmatched system throws, so a flow that grows a
 * new model boundary fails loudly instead of silently reusing a fixture.
 * A response with the empty-string prefix matches every call, which is the
 * single-model-boundary case.
 *
 * A response's `content` may be a function of `(opts, call_index)` for
 * routes a flow hits more than once (a converging loop, a judged retry):
 * `call_index` counts how many times that route has matched before,
 * starting at 0, so each pass can answer differently.
 *
 * Canned content is validated through the caller's own schema
 * (`opts.schema['~standard'].validate`), so fixtures cannot drift from the
 * contracts they stand in for. A failure throws the engine's own
 * `schema_validation_error` carrying the issues and the canned content as
 * `raw_text`, exactly what a real engine throws when repair attempts run
 * out, so `instanceof` handling in the code under test stays testable.
 *
 * The engine's streaming and cancellation contract holds too: an
 * already-aborted `opts.abort` throws `aborted_error`, and a provided
 * `opts.on_chunk` receives the canned content as a text chunk plus a finish
 * chunk before the result resolves.
 */

import type { Engine, GenerateOptions, GenerateResult, UsageTotals } from '#engine'
import { DEFAULT_USAGE, emit_chunks, throw_if_aborted, validate_canned } from './canned.js'
import { engine_from_generate } from './engine_from_generate.js'

/**
 * The function form of canned content: called with the routed call's options
 * and how many times this prefix route has matched before (starting 0). May
 * be async; the returned value is validated and answered like static content.
 */
export type StubContentFn = (opts: GenerateOptions, call_index: number) => unknown

export type StubResponse = {
  readonly prefix: string
  /** Static content, or a `StubContentFn` invoked per matched call. */
  readonly content: unknown
}

export type StubEngineOptions = {
  readonly usage?: UsageTotals
  readonly model_id?: string
}

/**
 * Build an `Engine` that answers every generate call from `canned`,
 * routed by system-prompt prefix.
 *
 * `options.usage` sets the usage totals reported on every result (default
 * `{ input_tokens: 40, output_tokens: 20 }`, so cost lines render non-zero
 * numbers); `options.model_id` sets `model_resolved.model_id` (default
 * `'stub'`). The provider always reports as `'stub'`.
 */
export function make_stub_engine(
  canned: ReadonlyArray<StubResponse>,
  options: StubEngineOptions = {},
): Engine {
  const usage = options.usage ?? DEFAULT_USAGE
  const model_id = options.model_id ?? 'stub'
  const match_counts = new Map<StubResponse, number>()

  return engine_from_generate(
    async <t = string>(opts: GenerateOptions<t>): Promise<GenerateResult<t>> => {
      throw_if_aborted(opts.abort)
      const system = opts.system ?? ''
      const match = canned.find((c) => system.startsWith(c.prefix))
      if (match === undefined) {
        throw new Error(`make_stub_engine: no canned response for system: ${system || '(none)'}`)
      }
      const call_index = match_counts.get(match) ?? 0
      match_counts.set(match, call_index + 1)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const loose = opts as GenerateOptions
      const produced =
        typeof match.content === 'function'
          ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            await (match.content as StubContentFn)(loose, call_index)
          : match.content
      // Chunks carry the raw canned content, before validation, mirroring a
      // real stream where text flows and only then gets validated.
      await emit_chunks(opts.on_chunk, produced, 'stop', usage)
      const content = await validate_canned(
        opts.schema,
        produced,
        `make_stub_engine: canned response for prefix '${match.prefix}'`,
      )
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: content as t,
        tool_calls: [],
        steps: [],
        usage,
        finish_reason: 'stop',
        model_resolved: { provider: 'stub', model_id },
      }
    },
  )
}
