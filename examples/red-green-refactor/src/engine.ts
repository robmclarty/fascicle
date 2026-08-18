/**
 * Engine factory for red-green-refactor: the one `create_engine` call site.
 *
 * This harness needs an agent that can read and write files in the workspace,
 * so it runs on the `claude_cli` provider (OAuth, `claude` on PATH) and uses
 * the CLI's own built-in editing tools. Model ids are opaque to the engine and
 * passed to the provider verbatim; `sonnet` is a CLI-side name, which is why
 * the default lives next to the provider that understands it.
 *
 * The test seam is `make_stub_engine` from `fascicle/testing`, which the flow
 * test wraps with a canned prose reply so the topology runs without a
 * subprocess or a network.
 */

import { create_engine, type Engine } from 'fascicle'

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
