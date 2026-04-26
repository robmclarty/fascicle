/**
 * OpenRouter provider adapter.
 *
 * Wraps @openrouter/ai-sdk-provider as an optional peer. Reasoning effort
 * support varies per upstream model; OpenRouter itself forwards the
 * `reasoning` provider option. We translate effort to the OpenRouter
 * `reasoning.effort` shape when provided. Effort_ignored is false so that
 * the orchestrator does not emit effort_ignored indiscriminately; upstream
 * models that don't support reasoning will drop the field.
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

type OpenrouterSdk = {
  createOpenRouter: (config: {
    apiKey?: string;
    baseURL?: string;
    extraBody?: Record<string, unknown>;
    headers?: Record<string, string>;
  }) => (model_id: string) => unknown;
};

export function translate_openrouter_effort(effort: EffortLevel): EffortTranslation {
  if (effort === 'none') return { provider_options: {}, effort_ignored: false };
  return {
    provider_options: {
      openrouter: { reasoning: { effort } },
    },
    effort_ignored: false,
  };
}

export function normalize_openrouter_usage(raw: RawProviderUsage | undefined): UsageTotals {
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

export const create_openrouter_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
  const api_key = typeof init.api_key === 'string' ? init.api_key : '';
  if (api_key.length === 0) {
    throw new engine_config_error(
      'openrouter provider requires a non-empty api_key',
      'openrouter',
    );
  }
  const base_url = typeof init.base_url === 'string' ? init.base_url : undefined;
  const http_referer = typeof init['http_referer'] === 'string' ? init['http_referer'] : undefined;
  const x_title = typeof init['x_title'] === 'string' ? init['x_title'] : undefined;

  return {
    kind: 'ai_sdk',
    name: 'openrouter',
    async build_model(model_id: string): Promise<unknown> {
      const sdk = await load_optional_peer<OpenrouterSdk>('@openrouter/ai-sdk-provider');
      const headers: Record<string, string> = {};
      if (http_referer !== undefined) headers['HTTP-Referer'] = http_referer;
      if (x_title !== undefined) headers['X-Title'] = x_title;
      const config: {
        apiKey: string;
        baseURL?: string;
        headers?: Record<string, string>;
      } = { apiKey: api_key };
      if (base_url !== undefined) config.baseURL = base_url;
      if (Object.keys(headers).length > 0) config.headers = headers;
      const provider = sdk.createOpenRouter(config);
      return provider(model_id);
    },
    translate_effort: translate_openrouter_effort,
    normalize_usage: normalize_openrouter_usage,
    supports: (capability) => SUPPORTED.has(capability),
  };
};
