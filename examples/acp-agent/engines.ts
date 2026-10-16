/**
 * The `--provider` switch the ACP examples share.
 *
 * An agent that Zed launches authenticates with whatever its process can
 * see, so every key here comes from the environment, and the place to set it
 * is the `env` of the agent server entry in Zed's settings. Every provider
 * that has a native transport uses it, so none of them needs a peer to be
 * installed; Bedrock is the exception.
 */

import { create_engine } from 'fascicle'
import type { Engine, ProviderConfigMap } from 'fascicle'

/** The value after a command-line flag, or undefined when the flag is absent. */
export function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * An API key from the environment. A missing key fails here, naming the
 * variable, rather than at the first prompt as a provider's 401.
 */
function api_key(name: string): string {
  const key = process.env[name] ?? ''
  if (key === '') {
    throw new Error(`${name} is not set: add it to the env of the agent server entry that launches this agent`)
  }
  return key
}

/**
 * The variable each keyed provider reads its API key from, so an agent that
 * runs commands can keep the keys out of their environment.
 */
export const API_KEYS = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
} as const

const PROVIDERS: Readonly<Record<string, () => ProviderConfigMap>> = {
  openrouter: () => ({ openrouter: { api_key: api_key(API_KEYS.openrouter), transport: 'native' } }),
  anthropic: () => ({ anthropic: { api_key: api_key(API_KEYS.anthropic), transport: 'native' } }),
  openai: () => ({ openai: { api_key: api_key(API_KEYS.openai), transport: 'native' } }),
  // Bedrock has no native transport, so it needs the ai, @ai-sdk/amazon-bedrock,
  // and @aws-sdk/credential-providers peers. The credential chain is what picks
  // up an existing `aws sso login` or a named profile.
  bedrock: () => ({ bedrock: { region: process.env['AWS_REGION'] ?? 'us-east-1', use_credential_chain: true } }),
  ollama: () => ({ ollama: { base_url: 'http://localhost:11434', transport: 'native' } }),
}

/** An engine for one provider by name, configured from the environment. */
export function engine_for(provider: string): Engine {
  const providers = PROVIDERS[provider]
  if (providers === undefined) {
    throw new Error(`unknown provider ${provider}: use ${Object.keys(PROVIDERS).join(', ')}`)
  }
  return create_engine({ providers: providers() })
}
