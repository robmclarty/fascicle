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
 * The test seam is `make_stub_engine` from `fascicle/testing`, imported by
 * the flow tests directly.
 */

import { create_engine, type Engine, type EffortLevel } from 'fascicle'

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
