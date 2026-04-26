/**
 * Google Gemini provider adapter.
 *
 * Wraps @ai-sdk/google as an optional peer. Effort maps to the
 * `thinking_budget` provider option per spec §6.3.
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

type GoogleSdk = {
  createGoogleGenerativeAI: (config: {
    apiKey?: string;
    baseURL?: string;
  }) => (model_id: string) => unknown;
};

const GOOGLE_THINKING_BUDGET: Record<Exclude<EffortLevel, 'none'>, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

export function translate_google_effort(effort: EffortLevel): EffortTranslation {
  if (effort === 'none') {
    return { provider_options: {}, effort_ignored: false };
  }
  return {
    provider_options: {
      google: { thinkingConfig: { thinkingBudget: GOOGLE_THINKING_BUDGET[effort] } },
    },
    effort_ignored: false,
  };
}

export function normalize_google_usage(raw: RawProviderUsage | undefined): UsageTotals {
  if (raw === undefined) return { input_tokens: 0, output_tokens: 0 };
  const base = default_normalize_usage(raw);
  // Google does not report cache-write tokens; strip if zero-like and absent.
  if (base.cache_write_tokens === undefined) {
    delete base.cache_write_tokens;
  }
  return base;
}

const SUPPORTED: ReadonlySet<ProviderCapability> = new Set([
  'text',
  'tools',
  'schema',
  'streaming',
  'image_input',
  'reasoning',
]);

export const create_google_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
  const api_key = typeof init.api_key === 'string' ? init.api_key : '';
  if (api_key.length === 0) {
    throw new engine_config_error(
      'google provider requires a non-empty api_key',
      'google',
    );
  }
  const base_url = typeof init.base_url === 'string' ? init.base_url : undefined;

  return {
    kind: 'ai_sdk',
    name: 'google',
    async build_model(model_id: string): Promise<unknown> {
      const sdk = await load_optional_peer<GoogleSdk>('@ai-sdk/google');
      const config: { apiKey: string; baseURL?: string } = { apiKey: api_key };
      if (base_url !== undefined) config.baseURL = base_url;
      const provider = sdk.createGoogleGenerativeAI(config);
      return provider(model_id);
    },
    translate_effort: translate_google_effort,
    normalize_usage: normalize_google_usage,
    supports: (capability) => SUPPORTED.has(capability),
  };
};
