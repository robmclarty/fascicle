/**
 * Engine factory for pr-improve.
 *
 * Two paths:
 *
 * - `create_app_engine(env)` — build a real engine from environment config.
 *   Provider selected by `FASCICLE_PROVIDER` (default: anthropic). Swapping
 *   providers is the explicit proof point of this app — no code changes
 *   should be required.
 *
 * The stub path (Phase A and tests) uses `make_stub_engine` from
 * `fascicle/testing`, imported by the shell and the tests directly.
 */

import { z } from 'zod'

import { create_engine, type Engine } from 'fascicle'

import type { FlowModels } from './types.js'

const provider_schema = z.enum(['anthropic', 'openrouter', 'claude_cli'])
export type Provider = z.infer<typeof provider_schema>

export type AppEngineConfig = {
  readonly provider: Provider
  readonly api_key: string
  readonly models: FlowModels
}

export type AppEngineOptions = {
  readonly cwd?: string
}

// The engine passes `model` to the provider verbatim, so ids are per provider:
// API providers need real ids, and only the `claude_cli` transport understands
// the CLI's own `sonnet`/`opus` shorthands. This table is the single source of
// truth for model defaults; `read_engine_env` resolves it once and the record
// is threaded to the flow as data.
const DEFAULT_MODELS: Readonly<Record<Provider, FlowModels>> = {
  anthropic: {
    reviewer: 'claude-sonnet-4-6',
    pragmatist: 'claude-opus-4-8',
    builder: 'claude-sonnet-4-6',
    build_reviewer: 'claude-opus-4-8',
  },
  openrouter: {
    reviewer: 'anthropic/claude-sonnet-4.6',
    pragmatist: 'anthropic/claude-opus-4.8',
    builder: 'anthropic/claude-sonnet-4.6',
    build_reviewer: 'anthropic/claude-opus-4.8',
  },
  claude_cli: {
    reviewer: 'sonnet',
    pragmatist: 'opus',
    builder: 'sonnet',
    build_reviewer: 'opus',
  },
}

// Models are irrelevant under the stub engine, which routes on the system
// prompt, but the flow still takes a full record.
export const STUB_MODELS: FlowModels = {
  reviewer: 'stub',
  pragmatist: 'stub',
  builder: 'stub',
  build_reviewer: 'stub',
}

/**
 * Resolve per-role models for a provider, applying any env overrides.
 */
function read_models(env: NodeJS.ProcessEnv, provider: Provider): FlowModels {
  const defaults = DEFAULT_MODELS[provider]
  return {
    reviewer: env['FASCICLE_MODEL_REVIEWER'] ?? defaults.reviewer,
    pragmatist: env['FASCICLE_MODEL_PRAGMATIST'] ?? defaults.pragmatist,
    builder: env['FASCICLE_MODEL_BUILDER'] ?? defaults.builder,
    build_reviewer: env['FASCICLE_MODEL_BUILD_REVIEWER'] ?? defaults.build_reviewer,
  }
}

export function read_engine_env(env: NodeJS.ProcessEnv = process.env, override_provider?: Provider): AppEngineConfig {
  const provider = override_provider ?? provider_schema.parse(env['FASCICLE_PROVIDER'] ?? 'anthropic')
  const models = read_models(env, provider)
  if (provider === 'claude_cli') {
    return { provider, api_key: '', models }
  }
  const api_key_var = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY'
  const api_key = env[api_key_var] ?? ''
  if (api_key.length === 0) {
    throw new Error(`${api_key_var} is required for FASCICLE_PROVIDER=${provider}`)
  }
  return { provider, api_key, models }
}

export function create_app_engine(cfg: AppEngineConfig, opts: AppEngineOptions = {}): Engine {
  if (cfg.provider === 'anthropic') {
    return create_engine({ providers: { anthropic: { api_key: cfg.api_key } } })
  }
  if (cfg.provider === 'openrouter') {
    return create_engine({ providers: { openrouter: { api_key: cfg.api_key } } })
  }
  return create_engine({
    providers: {
      claude_cli: {
        auth_mode: 'oauth',
        stall_timeout_ms: 900_000,
        ...(opts.cwd !== undefined ? { default_cwd: opts.cwd } : {}),
      },
    },
  })
}
