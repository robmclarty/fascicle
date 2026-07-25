/**
 * Engine factory for red-green-refactor: the one `create_engine` call site.
 *
 * This harness needs an agent that can read and write files in the workspace,
 * so it runs on the `claude_cli` provider (OAuth, `claude` on PATH) and uses
 * the CLI's own built-in editing tools. Model ids are opaque to the engine and
 * passed to the provider verbatim; `sonnet` is a CLI-side name, which is why
 * the default lives next to the provider that understands it.
 *
 * `make_stub_engine` is the test seam: it returns canned prose for every call,
 * so the flow test exercises the topology without a subprocess or a network.
 */

import { create_engine, type Engine, type GenerateResult } from 'fascicle'

import type { FlowModels } from './types.js'

export const DEFAULT_MODELS: FlowModels = {
  coder: 'sonnet',
}

export function create_app_engine(): Engine {
  return create_engine({
    providers: { claude_cli: { auth_mode: 'oauth' } },
    defaults: { provider: 'claude_cli', model: DEFAULT_MODELS.coder },
  })
}

export function make_stub_engine(reply = 'stub: applied the requested change'): Engine {
  return {
    generate: async <T = string>(): Promise<GenerateResult<T>> => ({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      content: reply as T,
      tool_calls: [],
      steps: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      finish_reason: 'stop',
      model_resolved: { provider: 'stub', model_id: 'rgr-stub' },
    }),
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    with_providers: () => {
      throw new Error('stub engine does not support with_providers')
    },
    dispose: async () => {},
  }
}
