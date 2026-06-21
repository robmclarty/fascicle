/**
 * Ollama local-provider adapter.
 *
 * Wraps ai-sdk-ollama as an optional peer. No API key; base_url is required.
 * Ollama does not support reasoning effort: the field is silently dropped
 * and the effort_ignored flag is set so the orchestrator records
 * `effort_ignored`. Ollama does not emit image_input capability by default
 * in v1.
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

type OllamaSdk = {
  createOllama: (config: { baseURL?: string }) => (model_id: string) => unknown
}

export function translate_ollama_effort(effort: EffortLevel): EffortTranslation {
  const ignored = effort !== 'none'
  return { provider_options: {}, effort_ignored: ignored }
}

export function normalize_ollama_usage(raw: RawProviderUsage | undefined): UsageTotals {
  // default_normalize_usage already maps undefined to a zero total; Ollama
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
  // Ollama supports native constrained decoding via its `format` field, which
  // ai-sdk-ollama maps from the AI SDK responseFormat. The text-extraction
  // path is unreliable for local models, so prefer the constrained decode.
  'structured_output',
])

export const create_ollama_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
  const base_url = typeof init.base_url === 'string' ? init.base_url : ''
  if (base_url.length === 0) {
    throw new engine_config_error(
      'ollama provider requires a non-empty base_url',
      'ollama',
    )
  }

  return {
    kind: 'ai_sdk',
    name: 'ollama',
    async build_model(model_id: string): Promise<unknown> {
      const sdk = await load_optional_peer<OllamaSdk>('ai-sdk-ollama')
      const provider = sdk.createOllama({ baseURL: base_url })
      return provider(model_id)
    },
    translate_effort: translate_ollama_effort,
    normalize_usage: normalize_ollama_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}
