/**
 * LM Studio provider adapter.
 *
 * Dispatches on `transport`: the default 'ai_sdk' backend wraps
 * @ai-sdk/openai-compatible as an optional peer; 'native' builds the lmstudio
 * dialect of the shared OpenAI-compatible core, with no auth, `max_tokens` as
 * the token-limit field, and tolerant usage, since a local server that omits
 * or approximates token counts is a fact of local-first running, not a broken
 * response. LM Studio exposes an OpenAI-compatible local server; base_url is
 * required on both transports. No reasoning support.
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

type OpenaiCompatibleSdk = {
  createOpenAICompatible: (config: {
    name: string
    baseURL: string
    apiKey?: string
    includeUsage?: boolean
  }) => (model_id: string) => unknown
}

/**
 * LM Studio has no reasoning-effort control, so every non-`none` level is
 * reported as ignored and no provider option is emitted.
 */
export function translate_lmstudio_effort(effort: EffortLevel): EffortTranslation {
  const ignored = effort !== 'none'
  return { provider_options: {}, effort_ignored: ignored }
}

/**
 * Normalize LM Studio's raw usage payload into UsageTotals.
 */
export function normalize_lmstudio_usage(raw: RawProviderUsage | undefined): UsageTotals {
  // default_normalize_usage already maps undefined to a zero total; LM Studio
  // additionally never reports cache or reasoning tokens, so strip them.
  const base = default_normalize_usage(raw)
  delete base.cached_input_tokens
  delete base.cache_write_tokens
  delete base.reasoning_tokens
  return base
}

const SUPPORTED: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'streaming',
  // LM Studio's OpenAI-compatible server supports native constrained decoding
  // via a json_schema response format, surfaced through the AI SDK
  // responseFormat. Prefer it over the unreliable text-extraction path.
  'structured_output',
])

/**
 * Build the LM Studio adapter, picking the native or ai_sdk backend per the
 * resolved `transport`.
 */
export const create_lmstudio_adapter = (init: ProviderInit): ProviderAdapter => {
  if (resolve_transport(init, 'lmstudio') === 'native') {
    return create_lmstudio_native_adapter(init)
  }
  return create_lmstudio_ai_sdk_adapter(init)
}

/**
 * Build the lmstudio dialect and hand it to the shared OpenAI-compatible
 * core: no auth, the `max_tokens` token-limit field, and tolerant usage. The
 * base_url guard mirrors the ai_sdk branch; the core has no api_key to check
 * under `auth: { kind: 'none' }`.
 */
const create_lmstudio_native_adapter = (init: ProviderInit): NativeProviderAdapter => {
  const base_url = typeof init.base_url === 'string' ? init.base_url : ''
  if (base_url.length === 0) {
    throw new engine_config_error(
      'lmstudio provider requires a non-empty base_url',
      'lmstudio',
    )
  }
  const dialect: OpenAICompatibleDialect = {
    name: 'lmstudio',
    base_url,
    auth: { kind: 'none' },
    token_limit_field: 'max_tokens',
    stream_include_usage: true,
    tolerant_usage: true,
  }
  return create_openai_compatible_adapter(dialect)
}

/**
 * Build the LM Studio ai_sdk adapter: validates the required base_url and
 * lazily loads @ai-sdk/openai-compatible to build models.
 */
const create_lmstudio_ai_sdk_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
  const base_url = typeof init.base_url === 'string' ? init.base_url : ''
  if (base_url.length === 0) {
    throw new engine_config_error(
      'lmstudio provider requires a non-empty base_url',
      'lmstudio',
    )
  }

  return {
    kind: 'ai_sdk',
    name: 'lmstudio',
    async build_model(model_id: string): Promise<unknown> {
      const sdk = await load_optional_peer<OpenaiCompatibleSdk>('@ai-sdk/openai-compatible')
      // Without includeUsage the OpenAI streaming protocol omits usage from
      // SSE responses entirely (stream_options.include_usage), so streamed
      // calls would report zero tokens on spec-strict servers.
      const provider = sdk.createOpenAICompatible({
        name: 'lmstudio',
        baseURL: base_url,
        includeUsage: true,
      })
      return provider(model_id)
    },
    translate_effort: translate_lmstudio_effort,
    normalize_usage: normalize_lmstudio_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}
