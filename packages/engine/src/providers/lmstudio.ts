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
  if (raw === undefined) return { input_tokens: 0, output_tokens: 0 }
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
