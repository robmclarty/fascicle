/**
 * AWS Bedrock provider adapter.
 *
 * Wraps @ai-sdk/amazon-bedrock as an optional peer. `region` is required under
 * every auth mode; credentials are optional. The auth ladder, highest first:
 *
 * 1. `api_key` — Bedrock bearer token. Swaps the SDK's whole fetch function, so
 *    it wins over every SigV4 mode below and short-circuits their resolution.
 * 2. Explicit SigV4 fields — `access_key_id` / `secret_access_key` /
 *    `session_token`. Any one of them present means the caller is driving
 *    credentials, so no dynamic source is attached.
 * 3. A dynamic source — `use_credential_chain: true` (Fascicle loads
 *    @aws-sdk/credential-providers and attaches `fromNodeProviderChain()`) or a
 *    caller-supplied `credential_provider` function. Supplying both is an
 *    `engine_config_error`: they are two answers to one question, not a
 *    fallback pair.
 * 4. Nothing — the SDK reads `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from
 *    the environment and throws if they are absent. Note this is *not* the AWS
 *    credential chain: the SDK never reads `~/.aws/credentials`, so a profile
 *    without exported env vars needs mode 3.
 *
 * Effort maps to the Anthropic extended-thinking budget, emitted under the
 * bedrock `reasoningConfig` provider option; models that do not support
 * reasoning drop the field upstream.
 *
 * Guardrails ride `provider_options.bedrock.guardrailConfig`, which the peer
 * rest-spreads into the top level of the Converse command (an undocumented seam,
 * pinned by bedrock_guardrail_wire.test.ts). With `trace: 'enabled'` the
 * assessment comes back on `provider_reported.bedrock.trace`, which is the only
 * in-process evidence that a guardrail whose PII action is `NONE` ran at all:
 * that action detects and reports without rewriting, so the output is identical
 * whether such a guardrail is attached or absent.
 */

import type { BedrockCredentialProvider, EffortLevel, ProviderInit, UsageTotals } from '../types.js'
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
    credentialProvider?: BedrockCredentialProvider
  }) => (model_id: string) => unknown
}

// `fromNodeProviderChain()` returns a *memoized* provider: it caches resolved
// credentials and refreshes them on expiry. The SDK calls `credentialProvider`
// once per request, so the chain is built once per adapter and reused, never
// rebuilt inside build_model.
type CredentialProvidersSdk = {
  fromNodeProviderChain: () => BedrockCredentialProvider
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

/**
 * Map an EffortLevel to the Bedrock `reasoningConfig` provider option.
 */
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

/**
 * Normalize Bedrock's raw usage payload into UsageTotals.
 */
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

type BedrockConfig = Parameters<BedrockSdk['createAmazonBedrock']>[0]

/** Read a config field only when it is a string, so junk values stay unset. */
function read_string(init: ProviderInit, key: string): string | undefined {
  const value = init[key]
  return typeof value === 'string' ? value : undefined
}

/** The static credential fields the SDK accepts, mapped from snake_case init. */
type StaticCredentials = {
  readonly region: string
  readonly api_key: string | undefined
  readonly access_key_id: string | undefined
  readonly secret_access_key: string | undefined
  readonly session_token: string | undefined
  readonly base_url: string | undefined
}

/** Pull the static fields off init, rejecting a missing or non-string region. */
function read_static_credentials(init: ProviderInit): StaticCredentials {
  const region = read_string(init, 'region') ?? ''
  if (region.length === 0) {
    throw new engine_config_error('bedrock provider requires a non-empty region', 'bedrock')
  }
  return {
    region,
    api_key: read_string(init, 'api_key'),
    access_key_id: read_string(init, 'access_key_id'),
    secret_access_key: read_string(init, 'secret_access_key'),
    session_token: read_string(init, 'session_token'),
    base_url: read_string(init, 'base_url'),
  }
}

type DynamicSource =
  | { readonly kind: 'chain' }
  | { readonly kind: 'explicit', readonly provider: BedrockCredentialProvider }

/** True when the caller is already supplying credentials in any static form. */
function has_static_credentials(statics: StaticCredentials): boolean {
  return (
    statics.api_key !== undefined
    || statics.access_key_id !== undefined
    || statics.secret_access_key !== undefined
    || statics.session_token !== undefined
  )
}

/**
 * Pick the dynamic credential source, or none. A bearer token or any explicit
 * SigV4 field short-circuits it: attaching a provider anyway would either
 * override the caller's keys (the SDK prefers `credentialProvider` over
 * `accessKeyId`) or force the optional @aws-sdk/credential-providers peer on
 * bearer-token users who never need it. The conflict check runs first, since
 * naming two dynamic sources is a mistake whatever else is set.
 */
function resolve_dynamic_source(
  init: ProviderInit,
  statics: StaticCredentials,
): DynamicSource | undefined {
  const use_chain = init['use_credential_chain'] === true
  const raw = init['credential_provider']
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const provider = typeof raw === 'function' ? (raw as BedrockCredentialProvider) : undefined
  if (use_chain && provider !== undefined) {
    throw new engine_config_error(
      'bedrock provider accepts use_credential_chain or credential_provider, not both',
      'bedrock',
    )
  }
  if (has_static_credentials(statics)) return undefined
  if (provider !== undefined) return { kind: 'explicit', provider }
  return use_chain ? { kind: 'chain' } : undefined
}

/**
 * Build the camelCase config the SDK expects, assigning only fields that are
 * set so the object carries no `undefined` entries. The SDK reads either shape
 * identically; the tests assert on key presence, which is the cheaper signal
 * that a credential really was omitted rather than silently resolved.
 */
function to_sdk_config(
  statics: StaticCredentials,
  credential_provider: BedrockCredentialProvider | undefined,
): BedrockConfig {
  const config: BedrockConfig = { region: statics.region }
  if (statics.api_key !== undefined) config.apiKey = statics.api_key
  if (statics.access_key_id !== undefined) config.accessKeyId = statics.access_key_id
  if (statics.secret_access_key !== undefined) config.secretAccessKey = statics.secret_access_key
  if (statics.session_token !== undefined) config.sessionToken = statics.session_token
  if (statics.base_url !== undefined) config.baseURL = statics.base_url
  if (credential_provider !== undefined) config.credentialProvider = credential_provider
  return config
}

/**
 * Build the Bedrock ai_sdk adapter: validates the required region, resolves
 * the chosen auth mode (bearer token, explicit SigV4 keys, or a dynamic
 * credential source), and lazily loads @ai-sdk/amazon-bedrock to build models.
 * See the module docstring for the full precedence ladder.
 */
export const create_bedrock_adapter = (init: ProviderInit): AiSdkProviderAdapter => {
  const statics = read_static_credentials(init)
  const dynamic_source = resolve_dynamic_source(init, statics)

  let chain: BedrockCredentialProvider | undefined
  async function resolve_credential_provider(): Promise<BedrockCredentialProvider | undefined> {
    if (dynamic_source === undefined) return undefined
    if (dynamic_source.kind === 'explicit') return dynamic_source.provider
    chain ??= (
      await load_optional_peer<CredentialProvidersSdk>('@aws-sdk/credential-providers')
    ).fromNodeProviderChain()
    return chain
  }

  return {
    kind: 'ai_sdk',
    name: 'bedrock',
    async build_model(model_id: string): Promise<unknown> {
      const sdk = await load_optional_peer<BedrockSdk>('@ai-sdk/amazon-bedrock')
      const provider = sdk.createAmazonBedrock(
        to_sdk_config(statics, await resolve_credential_provider()),
      )
      return provider(model_id)
    },
    translate_effort: translate_bedrock_effort,
    normalize_usage: normalize_bedrock_usage,
    supports: (capability) => SUPPORTED.has(capability),
  }
}
