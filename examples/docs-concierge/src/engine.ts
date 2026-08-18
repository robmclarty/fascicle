/**
 * Engine factory for docs-concierge: the one `create_engine` call site.
 *
 * Provider is selected by `FASCICLE_PROVIDER` (default: anthropic); swapping
 * it is a one-env-var change. Model ids are opaque to the engine and resolved
 * verbatim by each provider, so the defaults table below is per provider and
 * lives in exactly one place. `FASCICLE_MODEL_ANSWERER` overrides the role's
 * model for any provider; the resolved value is threaded to the answerer
 * stage as data.
 */

import { z } from 'zod'

import { create_engine, type Engine } from 'fascicle'

const provider_schema = z.enum(['anthropic', 'ollama', 'claude_cli'])
export type Provider = z.infer<typeof provider_schema>

const DEFAULT_MODELS: Readonly<Record<Provider, string>> = {
  anthropic: 'claude-sonnet-4-6',
  ollama: 'llama3.1:8b',
  claude_cli: 'sonnet',
}

export type AppEngineConfig = {
  readonly provider: Provider
  readonly api_key: string
  readonly ollama_base_url: string
  readonly model_answerer: string
}

export function read_engine_env(env: NodeJS.ProcessEnv = process.env, override_provider?: Provider): AppEngineConfig {
  const provider = override_provider ?? provider_schema.parse(env['FASCICLE_PROVIDER'] ?? 'anthropic')
  const api_key = env['ANTHROPIC_API_KEY'] ?? ''
  if (provider === 'anthropic' && api_key.length === 0) {
    throw new Error('ANTHROPIC_API_KEY is required for FASCICLE_PROVIDER=anthropic')
  }
  return {
    provider,
    api_key,
    ollama_base_url: env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    model_answerer: env['FASCICLE_MODEL_ANSWERER'] ?? DEFAULT_MODELS[provider],
  }
}

export function create_app_engine(cfg: AppEngineConfig): Engine {
  if (cfg.provider === 'anthropic') {
    return create_engine({ providers: { anthropic: { api_key: cfg.api_key } } })
  }
  if (cfg.provider === 'ollama') {
    return create_engine({ providers: { ollama: { base_url: cfg.ollama_base_url } } })
  }
  return create_engine({ providers: { claude_cli: { auth_mode: 'oauth' } } })
}
