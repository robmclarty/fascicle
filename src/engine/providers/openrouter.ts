/**
 * OpenRouter provider adapter.
 *
 * Dispatches on `transport` (D3): the default 'ai_sdk' backend wraps
 * @openrouter/ai-sdk-provider as an optional peer; 'native' builds the
 * openrouter dialect of the shared OpenAI-compatible core (D1) — Bearer auth
 * plus the optional `HTTP-Referer`/`X-Title` attribution headers, `max_tokens`
 * as the token-limit field, and strict usage (a hosted aggregator omitting
 * usage is a broken response, not a local-runtime quirk).
 *
 * Reasoning effort support varies per upstream model; OpenRouter itself
 * forwards the `reasoning` provider option. The ai_sdk backend translates
 * effort to the OpenRouter `reasoning.effort` shape; the native core maps it to
 * the flat `reasoning_effort` field per Appendix A4. Effort_ignored is false so
 * that the orchestrator does not emit effort_ignored indiscriminately; upstream
 * models that don't support reasoning will drop the field.
 */

import type { EffortLevel, ProviderInit, UsageTotals } from '../types.js'
import {
  default_normalize_usage,
  load_optional_peer,
  resolve_transport,
  type AiSdkProviderAdapter,
  type EffortTranslation,
  type NativeProviderAdapter,
  type ProviderAdapter,
  type ProviderCapability,
  type RawProviderUsage,
} from './types.js'
import {
  create_openai_compatible_adapter,
  type OpenAICompatibleDialect,
} from './openai_compatible_native.js'
import { engine_config_error } from '../errors.js'

type OpenrouterSdk = {
  createOpenRouter: (config: {
    apiKey?: string
    baseURL?: string
    extraBody?: Record<string, unknown>
    headers?: Record<string, string>
  }) => (model_id: string) => unknown
}

// OpenRouter forwards the effort string verbatim to the upstream model.
// `low`/`medium`/`high` work everywhere; `xhigh`/`max` flow through but
// only the upstream model decides what they mean. Models that don't
// recognize the value drop it silently.
export function translate_openrouter_effort(effort: EffortLevel): EffortTranslation {
  if (effort === 'none') return { provider_options: {}, effort_ignored: false }
  return {
    provider_options: {
      openrouter: { reasoning: { effort } },
    },
    effort_ignored: false,
  }
}

export function normalize_openrouter_usage(raw: RawProviderUsage | undefined): UsageTotals {
  return default_normalize_usage(raw)
}

const SUPPORTED: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'streaming',
  'image_input',
  'reasoning',
])

/**
 * OpenRouter's default API origin, matching the @openrouter/ai-sdk-provider
 * baseURL convention so a base_url configured for the ai_sdk transport keeps
 * pointing at the same place when the transport flips to native.
 */
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

export const create_openrouter_adapter = (init: ProviderInit): ProviderAdapter => {
  if (resolve_transport(init, 'openrouter') === 'native') {
    return create_openrouter_native_adapter(init)
  }
  return create_openrouter_ai_sdk_adapter(init)
}

/**
 * Build the openrouter dialect (Appendix A1) and hand it to the shared
 * OpenAI-compatible core: Bearer auth, the optional `HTTP-Referer`/`X-Title`
 * attribution headers, the `max_tokens` token-limit field, and strict usage.
 * The empty-api_key guard rides on the core, which throws the same
 * `openrouter provider requires a non-empty api_key` engine_config_error.
 */
const create_openrouter_native_adapter = (init: ProviderInit): NativeProviderAdapter => {
  const api_key = typeof init.api_key === 'string' ? init.api_key : ''
  const base_url =
    typeof init.base_url === 'string' && init.base_url.length > 0 ? init.base_url : DEFAULT_BASE_URL
  const http_referer = typeof init['http_referer'] === 'string' ? init['http_referer'] : undefined
  const x_title = typeof init['x_title'] === 'string' ? init['x_title'] : undefined
  const extra_headers: Record<string, string> = {}
  if (http_referer !== undefined) extra_headers['HTTP-Referer'] = http_referer
  if (x_title !== undefined) extra_headers['X-Title'] = x_title
  const dialect: OpenAICompatibleDialect = {
    name: 'openrouter',
    base_url,
    auth: { kind: 'bearer', api_key },
    token_limit_field: 'max_tokens',
    stream_include_usage: true,
    tolerant_usage: false,
    ...(Object.keys(extra_headers).length > 0 ? { extra_headers } : {}),
  }
  return create_openai_compatible_adapter(dialect)
}

const create_openrouter_ai_sdk_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
  const api_key = typeof init.api_key === 'string' ? init.api_key : ''
  if (api_key.length === 0) {
    throw new engine_config_error(
      'openrouter provider requires a non-empty api_key',
      'openrouter',
    )
  }
  const base_url = typeof init.base_url === 'string' ? init.base_url : undefined
  const http_referer = typeof init['http_referer'] === 'string' ? init['http_referer'] : undefined
  const x_title = typeof init['x_title'] === 'string' ? init['x_title'] : undefined

  return {
    kind: 'ai_sdk',
    name: 'openrouter',
    async build_model(model_id: string): Promise<unknown> {
      const sdk = await load_optional_peer<OpenrouterSdk>('@openrouter/ai-sdk-provider')
      const headers: Record<string, string> = {}
      if (http_referer !== undefined) headers['HTTP-Referer'] = http_referer
      if (x_title !== undefined) headers['X-Title'] = x_title
      const config: {
        apiKey: string
        baseURL?: string
        headers?: Record<string, string>
      } = { apiKey: api_key }
      if (base_url !== undefined) config.baseURL = base_url
      if (Object.keys(headers).length > 0) config.headers = headers
      const provider = sdk.createOpenRouter(config)
      return provider(model_id)
    },
    translate_effort: translate_openrouter_effort,
    normalize_usage: normalize_openrouter_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}
