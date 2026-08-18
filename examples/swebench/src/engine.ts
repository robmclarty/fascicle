/**
 * Engine factories for swebench: the only `create_engine` call site.
 *
 * Two shapes, because the two providers differ in lifetime:
 *
 * - `anthropic` gets one shared engine for the whole run; the flow injects
 *   Sandbox-bound tools on every call.
 * - `claude_cli` gets one engine per case, because `default_cwd` has to point
 *   at that case's sandbox workdir. `flow.ts` asks for it by calling
 *   `create_case_engine`, so provider construction still lives here.
 *
 * Model ids are opaque to the engine and forwarded to the provider verbatim,
 * so the defaults are per provider: `sonnet` is a name only the CLI resolves.
 */

import { create_engine, type Engine } from 'fascicle'
import type { EffortLevel } from 'fascicle'

type Provider = 'anthropic' | 'claude_cli'

const DEFAULT_MODELS: Readonly<Record<Provider, string>> = {
  anthropic: 'claude-sonnet-4-6',
  claude_cli: 'sonnet',
}

const DEFAULT_EFFORT: EffortLevel = 'medium'

const VALID_EFFORTS: ReadonlySet<string> = new Set<EffortLevel>([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

export type EngineConfigForRun =
  | {
      readonly provider: 'claude_cli'
      readonly model: string
      readonly effort: EffortLevel
    }
  | {
      readonly provider: 'anthropic'
      readonly model: string
      readonly api_key: string
    }

function is_effort(value: string): value is EffortLevel {
  return VALID_EFFORTS.has(value)
}

function read_effort(env: NodeJS.ProcessEnv): EffortLevel {
  const raw = env['SWEBENCH_EFFORT'] ?? DEFAULT_EFFORT
  if (!is_effort(raw)) {
    throw new Error(
      `SWEBENCH_EFFORT="${raw}" is not a valid effort level (none|low|medium|high|xhigh|max).`,
    )
  }
  return raw
}

function read_api_key(env: NodeJS.ProcessEnv): string {
  const api_key = env['ANTHROPIC_API_KEY'] ?? ''
  if (api_key.length === 0) {
    throw new Error('SWEBENCH_PROVIDER=anthropic requires ANTHROPIC_API_KEY.')
  }
  return api_key
}

/**
 * Resolve provider, model, and effort from the environment.
 *
 * `SWEBENCH_PROVIDER` selects the transport (default `claude_cli`);
 * `SWEBENCH_MODEL` and `SWEBENCH_EFFORT` override the per-provider defaults.
 */
export function read_engine_env(env: NodeJS.ProcessEnv = process.env): EngineConfigForRun {
  const provider = (env['SWEBENCH_PROVIDER'] ?? 'claude_cli').toLowerCase()
  if (provider !== 'claude_cli' && provider !== 'anthropic') {
    throw new Error(`SWEBENCH_PROVIDER="${provider}" not recognized. Use 'claude_cli' or 'anthropic'.`)
  }
  const model = env['SWEBENCH_MODEL'] ?? DEFAULT_MODELS[provider]
  return provider === 'claude_cli'
    ? { provider, model, effort: read_effort(env) }
    : { provider, model, api_key: read_api_key(env) }
}

/**
 * Build the run-wide engine for API providers.
 */
export function create_app_engine(cfg: Extract<EngineConfigForRun, { provider: 'anthropic' }>): Engine {
  return create_engine({
    providers: { anthropic: { api_key: cfg.api_key } },
    defaults: { model: cfg.model },
  })
}

export type CaseEngineOptions = {
  readonly model: string
  readonly effort?: EffortLevel
  readonly auth_mode?: 'auto' | 'oauth' | 'api_key'
  readonly cwd: string
}

/**
 * Build a per-case `claude_cli` engine pinned to one sandbox workdir.
 *
 * The CLI's built-in Read/Write/Edit/Bash operate against the working
 * directory, which is what makes the sandbox the agent's whole world.
 */
export function create_case_engine(opts: CaseEngineOptions): Engine {
  return create_engine({
    providers: {
      claude_cli: {
        auth_mode: opts.auth_mode ?? 'oauth',
        default_cwd: opts.cwd,
      },
    },
    defaults: {
      model: opts.model,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    },
  })
}
