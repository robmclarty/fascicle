/**
 * LM Studio provider adapter.
 *
 * Wraps @ai-sdk/openai-compatible as an optional peer (LM Studio exposes an
 * OpenAI-compatible local server). No API key; base_url is required.
 * No reasoning support.
 */

import type { EffortLevel, ProviderInit, UsageTotals } from '../types.js'
import {
  default_normalize_usage,
  load_optional_peer,
  type AiSdkProviderAdapter,
  type EffortTranslation,
  type ProviderCapability,
  type RawProviderUsage,
} from './types.js'
import { engine_config_error } from '../errors.js'

type OpenaiCompatibleSdk = {
  createOpenAICompatible: (config: {
    name: string
    baseURL: string
    apiKey?: string
  }) => (model_id: string) => unknown
}

export function translate_lmstudio_effort(effort: EffortLevel): EffortTranslation {
  const ignored = effort !== 'none'
  return { provider_options: {}, effort_ignored: ignored }
}

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

export const create_lmstudio_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
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
      const provider = sdk.createOpenAICompatible({ name: 'lmstudio', baseURL: base_url })
      return provider(model_id)
    },
    translate_effort: translate_lmstudio_effort,
    normalize_usage: normalize_lmstudio_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}
