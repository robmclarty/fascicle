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
 * Canned content is validated through the caller's own schema
 * (`opts.schema['~standard'].validate`), so fixtures cannot drift from the
 * contracts they stand in for: a schema change breaks the test that ships
 * stale data.
 */

import type { Engine, GenerateOptions, GenerateResult, UsageTotals } from '#engine'
import { engine_from_generate } from './engine_from_generate.js'

export type StubResponse = {
  readonly prefix: string
  readonly content: unknown
}

export type StubEngineOptions = {
  readonly usage?: UsageTotals
  readonly model_id?: string
}

const DEFAULT_USAGE: UsageTotals = { input_tokens: 40, output_tokens: 20 }

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

  return engine_from_generate(
    async <t = string>(opts: GenerateOptions<t>): Promise<GenerateResult<t>> => {
      const system = opts.system ?? ''
      const match = canned.find((c) => system.startsWith(c.prefix))
      if (match === undefined) {
        throw new Error(`make_stub_engine: no canned response for system: ${system || '(none)'}`)
      }
      const checked = await opts.schema?.['~standard'].validate(match.content)
      if (checked?.issues !== undefined) {
        throw new Error(
          `make_stub_engine: canned response for prefix '${match.prefix}' failed the caller's schema`,
        )
      }
      const content = checked === undefined ? match.content : checked.value
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
