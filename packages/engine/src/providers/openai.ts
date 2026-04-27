/**
 * OpenAI provider adapter.
 *
 * Wraps @ai-sdk/openai as an optional peer. Effort maps to the o-series
 * `reasoning_effort` string per spec §6.3. Non-reasoning models silently
 * ignore the effort field (providers without reasoning support drop it;
 * signaling is model-specific and handled by the orchestrator via the
 * `effort_ignored` flag).
 */

import type { EffortLevel, ProviderInit, UsageTotals } from '../types.js';
import {
  default_normalize_usage,
  load_optional_peer,
  type AiSdkProviderAdapter,
  type EffortTranslation,
  type ProviderCapability,
  type RawProviderUsage,
} from './types.js';
import { engine_config_error } from '../errors.js';

type OpenaiSdk = {
  createOpenAI: (config: {
    apiKey?: string;
    baseURL?: string;
    organization?: string;
  }) => (model_id: string) => unknown;
};

// OpenAI's reasoning effort enum is `low | medium | high` only.
// `xhigh` and `max` clamp to `high` until OpenAI exposes more levels.
const OPENAI_REASONING_EFFORT: Record<Exclude<EffortLevel, 'none'>, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
};

export function translate_openai_effort(effort: EffortLevel): EffortTranslation {
  if (effort === 'none') {
    return { provider_options: {}, effort_ignored: false };
  }
  return {
    provider_options: {
      openai: { reasoningEffort: OPENAI_REASONING_EFFORT[effort] },
    },
    effort_ignored: false,
  };
}

export function normalize_openai_usage(raw: RawProviderUsage | undefined): UsageTotals {
  return default_normalize_usage(raw);
}

const SUPPORTED: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'streaming',
  'image_input',
  'reasoning',
]);

export const create_openai_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
  const api_key = typeof init.api_key === 'string' ? init.api_key : '';
  if (api_key.length === 0) {
    throw new engine_config_error(
      'openai provider requires a non-empty api_key',
      'openai',
    );
  }
  const base_url = typeof init.base_url === 'string' ? init.base_url : undefined;
  const organization = typeof init['organization'] === 'string' ? init['organization'] : undefined;

  return {
    kind: 'ai_sdk',
    name: 'openai',
    async build_model(model_id: string): Promise<unknown> {
      const sdk = await load_optional_peer<OpenaiSdk>('@ai-sdk/openai');
      const config: { apiKey: string; baseURL?: string; organization?: string } = {
        apiKey: api_key,
      };
      if (base_url !== undefined) config.baseURL = base_url;
      if (organization !== undefined) config.organization = organization;
      const provider = sdk.createOpenAI(config);
      return provider(model_id);
    },
    translate_effort: translate_openai_effort,
    normalize_usage: normalize_openai_usage,
    supports: (capability) => SUPPORTED.has(capability),
  };
};
