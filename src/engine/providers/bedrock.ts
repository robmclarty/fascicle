/**
 * AWS Bedrock provider adapter.
 *
 * Wraps @ai-sdk/amazon-bedrock as an optional peer. `region` is required under
 * every auth mode; credentials are optional. Supply an `api_key` (Bedrock bearer
 * token, takes precedence over SigV4), SigV4 keys (`access_key_id` /
 * `secret_access_key`, optional `session_token`), or omit all three to use the
 * ambient AWS credential chain. Effort maps to the Anthropic extended-thinking
 * budget, emitted under the bedrock `reasoningConfig` provider option; models
 * that do not support reasoning drop the field upstream.
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

type BedrockSdk = {
  createAmazonBedrock: (config: {
    region?: string
    accessKeyId?: string
    secretAccessKey?: string
    sessionToken?: string
    apiKey?: string
    baseURL?: string
  }) => (model_id: string) => unknown
}

// Bedrock hosts Anthropic Claude models; reasoning maps to the same
// extended-thinking budget the anthropic adapter uses, emitted under the bedrock
// provider option. Budgets stay within Bedrock's 1024..64000 window.
const BEDROCK_THINKING_BUDGETS: Record<EffortLevel, number> = {
  none: 0,
  low: 1024,
  medium: 5000,
  high: 20000,
  xhigh: 32000,
  max: 64000,
}

export function translate_bedrock_effort(effort: EffortLevel): EffortTranslation {
  // `none` is the only level with a 0 budget, so the budget alone decides
  // whether reasoning is requested.
  const budget = BEDROCK_THINKING_BUDGETS[effort]
  if (budget === 0) {
    return { provider_options: {}, effort_ignored: false }
  }
  return {
    provider_options: {
      bedrock: {
        reasoningConfig: { type: 'enabled', budgetTokens: budget },
      },
    },
    effort_ignored: false,
  }
}

export function normalize_bedrock_usage(raw: RawProviderUsage | undefined): UsageTotals {
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

export const create_bedrock_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
  const region = typeof init['region'] === 'string' ? init['region'] : ''
  if (region.length === 0) {
    throw new engine_config_error('bedrock provider requires a non-empty region', 'bedrock')
  }
  const api_key = typeof init.api_key === 'string' ? init.api_key : undefined
  const access_key_id = typeof init['access_key_id'] === 'string' ? init['access_key_id'] : undefined
  const secret_access_key =
    typeof init['secret_access_key'] === 'string' ? init['secret_access_key'] : undefined
  const session_token = typeof init['session_token'] === 'string' ? init['session_token'] : undefined
  const base_url = typeof init.base_url === 'string' ? init.base_url : undefined

  return {
    kind: 'ai_sdk',
    name: 'bedrock',
    async build_model(model_id: string): Promise<unknown> {
      const sdk = await load_optional_peer<BedrockSdk>('@ai-sdk/amazon-bedrock')
      const config: {
        region: string
        accessKeyId?: string
        secretAccessKey?: string
        sessionToken?: string
        apiKey?: string
        baseURL?: string
      } = { region }
      if (api_key !== undefined) config.apiKey = api_key
      if (access_key_id !== undefined) config.accessKeyId = access_key_id
      if (secret_access_key !== undefined) config.secretAccessKey = secret_access_key
      if (session_token !== undefined) config.sessionToken = session_token
      if (base_url !== undefined) config.baseURL = base_url
      const provider = sdk.createAmazonBedrock(config)
      return provider(model_id)
    },
    translate_effort: translate_bedrock_effort,
    normalize_usage: normalize_bedrock_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}
