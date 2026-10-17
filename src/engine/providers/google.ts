/**
 * Google Gemini provider adapter.
 *
 * Wraps @ai-sdk/google as an optional peer. Effort goes through the AI SDK's
 * own `reasoning` option, which @ai-sdk/google maps per model: `thinkingLevel`
 * on Gemini 3 and a `thinkingBudget` on Gemini 2.5.
 */

import type { ProviderInit, UsageTotals } from '../types.js'
import {
  default_normalize_usage,
  load_optional_peer,
  translate_effort_to_sdk_reasoning,
  type AiSdkProviderAdapter,
  type ProviderCapability,
  type RawProviderUsage,
} from './types.js'
import { engine_config_error } from '../errors.js'

type GoogleSdk = {
  createGoogleGenerativeAI: (config: {
    apiKey?: string
    baseURL?: string
  }) => (model_id: string) => unknown
}

/**
 * Normalize Google's raw usage payload into UsageTotals.
 */
export function normalize_google_usage(raw: RawProviderUsage | undefined): UsageTotals {
  // Google never reports cache-write tokens, and `default_normalize_usage` only
  // sets that field when the raw payload carries it, so the default is exact.
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
 * Build the Google ai_sdk adapter: validates the required api_key and lazily
 * loads @ai-sdk/google to build models.
 */
export const create_google_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
  const api_key = typeof init.api_key === 'string' ? init.api_key : ''
  if (api_key.length === 0) {
    throw new engine_config_error(
      'google provider requires a non-empty api_key',
      'google',
    )
  }
  const base_url = typeof init.base_url === 'string' ? init.base_url : undefined

  return {
    kind: 'ai_sdk',
    name: 'google',
    async build_model(model_id: string): Promise<unknown> {
      const sdk = await load_optional_peer<GoogleSdk>('@ai-sdk/google')
      const config: { apiKey: string; baseURL?: string } = { apiKey: api_key }
      if (base_url !== undefined) config.baseURL = base_url
      const provider = sdk.createGoogleGenerativeAI(config)
      return provider(model_id)
    },
    translate_effort: translate_effort_to_sdk_reasoning,
    normalize_usage: normalize_google_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}
