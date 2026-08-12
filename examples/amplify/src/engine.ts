/**
 * Engine factory for amplify: the one `create_engine` call site.
 *
 * The loop runs on the `claude_cli` provider: it is the transport with the
 * richer hosted `WebSearch` used by the research stage, it authenticates by
 * OAuth (no metered key for a demo that makes hundreds of calls), and effort
 * levels are how reasoning depth is tuned on adaptive-reasoning models.
 *
 * Model ids are opaque to the engine and forwarded verbatim, so the defaults
 * are CLI-side names. Effort is threaded as data from the shell.
 *
 * `make_stub_engine` is the test seam: canned responses routed on the system
 * prompt's stable first line, validated through the caller's own schema.
 */

import { create_engine, type Engine, type EffortLevel, type GenerateOptions, type GenerateResult } from 'fascicle'

import type { FlowModels } from './types.js'

export const DEFAULT_MODELS: FlowModels = {
  proposer: 'opus',
  researcher: 'opus',
}

const DEFAULT_EFFORT: EffortLevel = 'xhigh'

export function create_app_engine(effort: EffortLevel = DEFAULT_EFFORT): Engine {
  return create_engine({
    providers: { claude_cli: { auth_mode: 'oauth' } },
    defaults: { provider: 'claude_cli', model: DEFAULT_MODELS.proposer, effort },
  })
}

export type StubResponse = {
  readonly match_system_prefix: string
  readonly content: unknown
}

export function make_stub_engine(responses: ReadonlyArray<StubResponse>): Engine {
  return {
    generate: async <T = unknown>(opts: GenerateOptions<T>): Promise<GenerateResult<T>> => {
      const system = opts.system ?? ''
      const match = responses.find((r) => system.startsWith(r.match_system_prefix))
      if (!match) {
        throw new Error(`make_stub_engine: no canned response for system:\n${system.slice(0, 120)}`)
      }
      const checked = await opts.schema?.['~standard'].validate(match.content)
      if (checked?.issues !== undefined) throw new Error('stub: canned response failed its schema')
      const parsed = checked === undefined ? match.content : checked.value
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: parsed as T,
        tool_calls: [],
        steps: [],
        usage: { input_tokens: 0, output_tokens: 0 },
        finish_reason: 'stop',
        model_resolved: { provider: 'stub', model_id: 'amplify-stub' },
      }
    },
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    with_providers: () => {
      throw new Error('stub engine does not support with_providers')
    },
    dispose: async () => {},
  }
}
