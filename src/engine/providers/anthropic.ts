/**
 * Anthropic provider adapter.
 *
 * Dispatches on `transport`: the default 'ai_sdk' backend wraps
 * @ai-sdk/anthropic as an optional peer; 'native' returns the raw-HTTP
 * adapter from anthropic_native.ts. On the AI SDK, effort goes through the
 * SDK's own `reasoning` option, which @ai-sdk/anthropic maps per model:
 * adaptive thinking with `effort` from Claude 4.6 on, a budget before that.
 * A cache setting goes through the call-level `cacheControl`, which the
 * package sends as the top-level `cache_control`.
 */

import type { CacheSetting, ProviderInit, UsageTotals } from '../types.js'
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
import { create_anthropic_native_adapter, read_one_hour_writes } from './anthropic_native.js'
import { engine_config_error } from '../errors.js'

type AnthropicSdk = {
  createAnthropic: (config: {
    apiKey?: string
    baseURL?: string
  }) => (model_id: string) => unknown
}

/**
 * Normalize Anthropic usage via the shared default mapper, since the AI SDK
 * already reports cache and reasoning tokens in the fields the default reads.
 * The one-hour part of a cache write comes from the raw usage that
 * @ai-sdk/anthropic keeps in `providerMetadata.anthropic.usage`, and stays
 * out when the metadata carries no split.
 */
export function normalize_anthropic_usage(
  raw: RawProviderUsage | undefined,
  provider_metadata?: unknown,
): UsageTotals {
  const totals = default_normalize_usage(raw)
  const cache_write_1h = read_one_hour_writes(read_path(provider_metadata, ['anthropic', 'usage', 'cache_creation']))
  if (cache_write_1h !== undefined) totals.cache_write_1h_tokens = cache_write_1h
  return totals
}

/** Follow `keys` down through nested objects, or undefined where one is missing. */
function read_path(value: unknown, keys: ReadonlyArray<string>): unknown {
  let current = value
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined
    current = Reflect.get(current, key)
  }
  return current
}

/**
 * Turn a cache setting into the call-level `cacheControl` that
 * @ai-sdk/anthropic sends as the top-level `cache_control`. A caller's own
 * `cacheControl` under `anthropic` wins, so nothing is derived beside it. A
 * caller's `cache_control` there, which the package drops from the call
 * options, comes back as `cacheControl` instead, so that spelling still
 * caches. With neither, `'off'` adds nothing.
 */
export function translate_anthropic_cache(
  cache: CacheSetting,
  provider_options: Readonly<Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  const own: unknown = provider_options?.['anthropic']
  const read = (key: string): unknown =>
    typeof own === 'object' && own !== null ? Reflect.get(own, key) : undefined
  if (read('cacheControl') !== undefined) return {}
  const raw = read('cache_control')
  if (raw !== undefined) return { anthropic: { cacheControl: raw } }
  if (cache === 'off') return {}
  return {
    anthropic: {
      cacheControl: cache === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' },
    },
  }
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
    prompt_cache: 'with_tools',
    translate_cache: translate_anthropic_cache,
  }
}
