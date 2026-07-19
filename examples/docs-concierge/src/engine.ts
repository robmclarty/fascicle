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

import { create_engine, type Engine, type GenerateOptions, type GenerateResult } from 'fascicle'

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
      const parsed = opts.schema ? opts.schema.parse(match.content) : match.content
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: parsed as T,
        tool_calls: [],
        steps: [],
        usage: { input_tokens: 100, output_tokens: 50 },
        finish_reason: 'stop',
        model_resolved: { provider: 'stub', model_id: 'docs-concierge-stub' },
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
