/**
 * Anthropic provider adapter.
 *
 * Dispatches on `transport` (D3): the default 'ai_sdk' backend wraps
 * @ai-sdk/anthropic as an optional peer; 'native' returns the raw-HTTP
 * adapter from anthropic_native.ts. Effort levels map to extended-thinking
 * budget tokens per spec §6.3.
 */

import type { EffortLevel, ProviderInit, UsageTotals } from '../types.js'
import {
  default_normalize_usage,
  load_optional_peer,
  resolve_transport,
  type AiSdkProviderAdapter,
  type EffortTranslation,
  type ProviderAdapter,
  type ProviderCapability,
  type RawProviderUsage,
} from './types.js'
import {
  ANTHROPIC_THINKING_BUDGETS,
  create_anthropic_native_adapter,
} from './anthropic_native.js'
import { engine_config_error } from '../errors.js'

type AnthropicSdk = {
  createAnthropic: (config: {
    apiKey?: string
    baseURL?: string
  }) => (model_id: string) => unknown
}

export function translate_anthropic_effort(effort: EffortLevel): EffortTranslation {
  const budget = ANTHROPIC_THINKING_BUDGETS[effort]
  if (effort === 'none' || budget === 0) {
    return { provider_options: {}, effort_ignored: false }
  }
  return {
    provider_options: {
      anthropic: {
        // @ai-sdk/anthropic reads `budgetTokens` (camelCase) and maps it to the
        // API's `budget_tokens`. Passing snake_case here is silently stripped by
        // the provider's zod schema, so the budget never reaches the wire.
        thinking: { type: 'enabled', budgetTokens: budget },
      },
    },
    effort_ignored: false,
  }
}

export function normalize_anthropic_usage(raw: RawProviderUsage | undefined): UsageTotals {
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

export const create_anthropic_adapter = (init: ProviderInit): ProviderAdapter => {
  if (resolve_transport(init, 'anthropic') === 'native') {
    return create_anthropic_native_adapter(init)
  }
  return create_anthropic_ai_sdk_adapter(init)
}

const create_anthropic_ai_sdk_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
  const api_key = typeof init.api_key === 'string' ? init.api_key : ''
  if (api_key.length === 0) {
    throw new engine_config_error(
      'anthropic provider requires a non-empty api_key',
      'anthropic',
    )
  }
  const base_url = typeof init.base_url === 'string' ? init.base_url : undefined

  return {
    kind: 'ai_sdk',
    name: 'anthropic',
    async build_model(model_id: string): Promise<unknown> {
      const sdk = await load_optional_peer<AnthropicSdk>('@ai-sdk/anthropic')
      const config: { apiKey: string; baseURL?: string } = { apiKey: api_key }
      if (base_url !== undefined) config.baseURL = base_url
      const provider = sdk.createAnthropic(config)
      return provider(model_id)
    },
    translate_effort: translate_anthropic_effort,
    normalize_usage: normalize_anthropic_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}
