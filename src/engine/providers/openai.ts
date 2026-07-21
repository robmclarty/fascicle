/**
 * OpenAI provider adapter.
 *
 * Dispatches on `transport`: the default 'ai_sdk' backend wraps
 * @ai-sdk/openai as an optional peer; 'native' builds the openai dialect of
 * the shared OpenAI-compatible core, with Bearer auth, an
 * OpenAI-Organization header, `max_completion_tokens`, and
 * `reasoning_effort`. Effort maps to the o-series `reasoning_effort` string.
 * Non-reasoning models silently ignore the effort field (providers without
 * reasoning support drop it; signaling is model-specific and handled by the
 * orchestrator via the `effort_ignored` flag).
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

type OpenaiSdk = {
  createOpenAI: (config: {
    apiKey?: string
    baseURL?: string
    organization?: string
  }) => (model_id: string) => unknown
}

// OpenAI's reasoning effort enum is `low | medium | high` only.
// `xhigh` and `max` clamp to `high` until OpenAI exposes more levels.
const OPENAI_REASONING_EFFORT: Record<Exclude<EffortLevel, 'none'>, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}

/**
 * Map an EffortLevel to OpenAI's `reasoningEffort` provider option.
 */
export function translate_openai_effort(effort: EffortLevel): EffortTranslation {
  if (effort === 'none') {
    return { provider_options: {}, effort_ignored: false }
  }
  return {
    provider_options: {
      openai: { reasoningEffort: OPENAI_REASONING_EFFORT[effort] },
    },
    effort_ignored: false,
  }
}

/**
 * Normalize OpenAI's raw usage payload into UsageTotals.
 */
export function normalize_openai_usage(raw: RawProviderUsage | undefined): UsageTotals {
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
 * OpenAI's default API origin, matching the @ai-sdk/openai baseURL convention
 * (origin + /v1) so a base_url configured for the ai_sdk transport keeps
 * pointing at the same place when the transport flips to native.
 */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/**
 * Build the OpenAI adapter, picking the native or ai_sdk backend per the
 * resolved `transport`.
 */
export const create_openai_adapter = (init: ProviderInit): ProviderAdapter => {
  if (resolve_transport(init, 'openai') === 'native') {
    return create_openai_native_adapter(init)
  }
  return create_openai_ai_sdk_adapter(init)
}

/**
 * Build the openai dialect and hand it to the shared OpenAI-compatible core:
 * Bearer auth, an optional OpenAI-Organization header, the
 * `max_completion_tokens` token-limit field, and strict usage (a hosted API
 * omitting usage is a broken response, not a local-runtime quirk). The
 * empty-api_key guard rides on the core, which throws the same
 * `openai provider requires a non-empty api_key` engine_config_error.
 */
const create_openai_native_adapter = (init: ProviderInit): NativeProviderAdapter => {
  const api_key = typeof init.api_key === 'string' ? init.api_key : ''
  const base_url =
    typeof init.base_url === 'string' && init.base_url.length > 0 ? init.base_url : DEFAULT_BASE_URL
  const organization = typeof init['organization'] === 'string' ? init['organization'] : undefined
  const dialect: OpenAICompatibleDialect = {
    name: 'openai',
    base_url,
    auth: { kind: 'bearer', api_key },
    token_limit_field: 'max_completion_tokens',
    stream_include_usage: true,
    tolerant_usage: false,
    ...(organization !== undefined
      ? { extra_headers: { 'OpenAI-Organization': organization } }
      : {}),
  }
  return create_openai_compatible_adapter(dialect)
}

/**
 * Build the OpenAI ai_sdk adapter: validates the required api_key and lazily
 * loads @ai-sdk/openai to build models.
 */
const create_openai_ai_sdk_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
  const api_key = typeof init.api_key === 'string' ? init.api_key : ''
  if (api_key.length === 0) {
    throw new engine_config_error(
      'openai provider requires a non-empty api_key',
      'openai',
    )
  }
  const base_url = typeof init.base_url === 'string' ? init.base_url : undefined
  const organization = typeof init['organization'] === 'string' ? init['organization'] : undefined

  return {
    kind: 'ai_sdk',
    name: 'openai',
    async build_model(model_id: string): Promise<unknown> {
      const sdk = await load_optional_peer<OpenaiSdk>('@ai-sdk/openai')
      const config: { apiKey: string; baseURL?: string; organization?: string } = {
        apiKey: api_key,
      }
      if (base_url !== undefined) config.baseURL = base_url
      if (organization !== undefined) config.organization = organization
      const provider = sdk.createOpenAI(config)
      return provider(model_id)
    },
    translate_effort: translate_openai_effort,
    normalize_usage: normalize_openai_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}
