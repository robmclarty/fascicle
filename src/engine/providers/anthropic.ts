/**
 * Anthropic provider adapter.
 *
 * Dispatches on `transport`: the default 'ai_sdk' backend wraps
 * @ai-sdk/anthropic as an optional peer; 'native' returns the raw-HTTP
 * adapter from anthropic_native.ts. On the AI SDK, effort goes through the
 * SDK's own `reasoning` option, which @ai-sdk/anthropic maps per model:
 * adaptive thinking with `effort` from Claude 4.6 on, a budget before that.
 */

import type { ProviderInit, UsageTotals } from '../types.js'
import {
  default_normalize_usage,
  load_optional_peer,
  resolve_transport,
  translate_effort_to_sdk_reasoning,
  type AiSdkProviderAdapter,
  type ProviderAdapter,
  type ProviderCapability,
  type RawProviderUsage,
} from './types.js'
import { create_anthropic_native_adapter } from './anthropic_native.js'
import { engine_config_error } from '../errors.js'

type AnthropicSdk = {
  createAnthropic: (config: {
    apiKey?: string
    baseURL?: string
  }) => (model_id: string) => unknown
}

/**
 * Normalize Anthropic usage via the shared default mapper; the AI SDK already
 * reports cache and reasoning tokens in the fields the default reads.
 */
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

/**
 * Build the Anthropic adapter, dispatching on `init.transport`: 'native' for
 * the raw-HTTP Messages API adapter, otherwise the AI SDK wrapper.
 */
export const create_anthropic_adapter = (init: ProviderInit): ProviderAdapter => {
  if (resolve_transport(init, 'anthropic') === 'native') {
    return create_anthropic_native_adapter(init)
  }
  return create_anthropic_ai_sdk_adapter(init)
}

/**
 * Build the AI SDK-backed Anthropic adapter. Requires a non-empty api_key at
 * construction; @ai-sdk/anthropic itself loads lazily on first build_model so
 * the peer is only required when a model is actually used.
 */
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
    translate_effort: translate_effort_to_sdk_reasoning,
    normalize_usage: normalize_anthropic_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}
