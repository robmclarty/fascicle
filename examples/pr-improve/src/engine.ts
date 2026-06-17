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
 * - `make_stub_engine(canned)` — in-process stub for Phase A and tests. Picks
 *   a canned response keyed by the system prompt's first line. Validates
 *   each canned response against the call's schema if one is set.
 */

import { z } from 'zod'

import { create_engine, type Engine, type GenerateOptions, type GenerateResult } from 'fascicle'

const ProviderSchema = z.enum(['anthropic', 'openrouter', 'claude_cli'])
export type Provider = z.infer<typeof ProviderSchema>

export type AppEngineConfig = {
  readonly provider: Provider
  readonly api_key: string
  readonly model_reviewer: string
  readonly model_pragmatist: string
  readonly model_builder: string
  readonly model_build_reviewer: string
}

export type AppEngineOptions = {
  readonly cwd?: string
}

// Provider-agnostic family names. The transport is chosen by `provider`; the
// engine resolves each family to the right id per provider ("latest of family").
const DEFAULT_MODELS = {
  reviewer: 'sonnet',
  pragmatist: 'opus',
  builder: 'sonnet',
  build_reviewer: 'opus',
} as const

export function read_engine_env(env: NodeJS.ProcessEnv = process.env, override_provider?: Provider): AppEngineConfig {
  const provider = override_provider ?? ProviderSchema.parse(env['FASCICLE_PROVIDER'] ?? 'anthropic')
  const defaults = DEFAULT_MODELS
  if (provider === 'claude_cli') {
    return {
      provider,
      api_key: '',
      model_reviewer: env['FASCICLE_MODEL_REVIEWER'] ?? defaults.reviewer,
      model_pragmatist: env['FASCICLE_MODEL_PRAGMATIST'] ?? defaults.pragmatist,
      model_builder: env['FASCICLE_MODEL_BUILDER'] ?? defaults.builder,
      model_build_reviewer: env['FASCICLE_MODEL_BUILD_REVIEWER'] ?? defaults.build_reviewer,
    }
  }
  const api_key_var = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY'
  const api_key = env[api_key_var] ?? ''
  if (api_key.length === 0) {
    throw new Error(`${api_key_var} is required for FASCICLE_PROVIDER=${provider}`)
  }
  return {
    provider,
    api_key,
    model_reviewer: env['FASCICLE_MODEL_REVIEWER'] ?? defaults.reviewer,
    model_pragmatist: env['FASCICLE_MODEL_PRAGMATIST'] ?? defaults.pragmatist,
    model_builder: env['FASCICLE_MODEL_BUILDER'] ?? defaults.builder,
    model_build_reviewer: env['FASCICLE_MODEL_BUILD_REVIEWER'] ?? defaults.build_reviewer,
  }
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
        throw new Error(
          `make_stub_engine: no canned response matches system prefix\nGot system:\n${system.slice(0, 200)}`,
        )
      }
      const parsed = opts.schema ? opts.schema.parse(match.content) : match.content
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: parsed as T,
        tool_calls: [],
        steps: [],
        usage: { input_tokens: 100, output_tokens: 50 },
        finish_reason: 'stop',
        model_resolved: { provider: 'stub', model_id: 'pr-improve-stub' },
      }
    },
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    dispose: async () => {},
  }
}
