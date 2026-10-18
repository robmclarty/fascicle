/**
 * Engine factory for pr-improve.
 *
 * `read_engine_env` picks the provider and its key, and `create_app_engine`
 * builds the engine for it. The provider is OpenRouter on the native
 * transport unless `--provider` or `FASCICLE_PROVIDER` names another, so
 * swapping providers takes a flag or an env change and no code. `claude_cli`
 * runs only when `--provider claude_cli` asks for it, since an API engine is
 * this app's main path.
 *
 * The stub path (Phase A and tests) uses `make_stub_engine` from
 * `fascicle/testing`, imported by the shell and the tests directly.
 */

import { z } from 'zod'

import { create_engine, type Engine, type EngineConfig } from 'fascicle'

import type { FlowModels } from './types.js'

const provider_schema = z.enum(['anthropic', 'openrouter', 'claude_cli'])
export type Provider = z.infer<typeof provider_schema>

export const PROVIDERS: ReadonlyArray<Provider> = provider_schema.options

const DEFAULT_PROVIDER: Provider = 'openrouter'

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

/**
 * Pick the provider: `--provider` first, then `FASCICLE_PROVIDER`, then
 * OpenRouter. The env var can't select `claude_cli`, so a shell that exports
 * it never moves every run onto the CLI without the flag that says so.
 */
export function resolve_provider(env: NodeJS.ProcessEnv, override_provider?: Provider): Provider {
  if (override_provider !== undefined) return override_provider
  const from_env = env['FASCICLE_PROVIDER']
  if (from_env === undefined || from_env === '') return DEFAULT_PROVIDER
  if (from_env === 'anthropic' || from_env === 'openrouter') return from_env
  throw new Error(
    `FASCICLE_PROVIDER=${from_env} is not one this app reads from the environment. Set it to anthropic or openrouter, or pass --provider claude_cli to run on the claude CLI.`,
  )
}

/**
 * Resolve the provider, its per-role models, and its API key from the
 * environment, failing early with the name of a missing key.
 */
export function read_engine_env(env: NodeJS.ProcessEnv = process.env, override_provider?: Provider): AppEngineConfig {
  const provider = resolve_provider(env, override_provider)
  const models = read_models(env, provider)
  if (provider === 'claude_cli') {
    return { provider, api_key: '', models }
  }
  const api_key_var = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY'
  const api_key = env[api_key_var] ?? ''
  if (api_key.length === 0) {
    throw new Error(`${api_key_var} is required for the ${provider} provider. Export it, or pick another with --provider.`)
  }
  return { provider, api_key, models }
}

/**
 * The `create_engine` config for a resolved provider. OpenRouter rides the
 * native transport, so the default path needs no AI SDK peer installed.
 */
export function app_engine_config(cfg: AppEngineConfig, opts: AppEngineOptions = {}): EngineConfig {
  if (cfg.provider === 'anthropic') {
    return { providers: { anthropic: { api_key: cfg.api_key } } }
  }
  if (cfg.provider === 'openrouter') {
    return { providers: { openrouter: { api_key: cfg.api_key, transport: 'native' } } }
  }
  return {
    providers: {
      claude_cli: {
        auth_mode: 'oauth',
        stall_timeout_ms: 900_000,
        ...(opts.cwd !== undefined ? { default_cwd: opts.cwd } : {}),
      },
    },
  }
}

/**
 * Build the app's one engine. This is the only `create_engine` call in the
 * app, so provider selection stays in this file.
 */
export function create_app_engine(cfg: AppEngineConfig, opts: AppEngineOptions = {}): Engine {
  return create_engine(app_engine_config(cfg, opts))
}
