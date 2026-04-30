/**
 * Model alias table and resolution.
 *
 * DEFAULT_ALIASES is frozen; user overrides flow through engine config or the
 * per-engine register_alias method, never via mutation of the defaults.
 */

import type { AliasTable, AliasTarget } from './types.js'
import { model_not_found_error } from './errors.js'

const KNOWN_PROVIDERS = new Set<string>([
  'anthropic',
  'openai',
  'google',
  'ollama',
  'lmstudio',
  'openrouter',
  'claude_cli',
])

export const DEFAULT_ALIASES: AliasTable = Object.freeze({
  'claude-opus': { provider: 'anthropic', model_id: 'claude-opus-4-7' },
  opus: { provider: 'anthropic', model_id: 'claude-opus-4-7' },
  'claude-sonnet': { provider: 'anthropic', model_id: 'claude-sonnet-4-6' },
  sonnet: { provider: 'anthropic', model_id: 'claude-sonnet-4-6' },
  'claude-haiku': { provider: 'anthropic', model_id: 'claude-haiku-4-5' },
  haiku: { provider: 'anthropic', model_id: 'claude-haiku-4-5' },

  'cli-opus': { provider: 'claude_cli', model_id: 'claude-opus-4-7' },
  'cli-sonnet': { provider: 'claude_cli', model_id: 'claude-sonnet-4-6' },
  'cli-haiku': { provider: 'claude_cli', model_id: 'claude-haiku-4-5' },

  'gpt-4o': { provider: 'openai', model_id: 'gpt-4o' },
  'gpt-4o-mini': { provider: 'openai', model_id: 'gpt-4o-mini' },

  'gemini-2.5-pro': { provider: 'google', model_id: 'gemini-2.5-pro' },
  'gemini-2.5-flash': { provider: 'google', model_id: 'gemini-2.5-flash' },
  'gemini-pro': { provider: 'google', model_id: 'gemini-2.5-pro' },
  'gemini-flash': { provider: 'google', model_id: 'gemini-2.5-flash' },

  'or:sonnet': { provider: 'openrouter', model_id: 'anthropic/claude-sonnet-4.5' },
  'or:opus': { provider: 'openrouter', model_id: 'anthropic/claude-opus-4.1' },
  'or:gpt-4o': { provider: 'openrouter', model_id: 'openai/gpt-4o' },
  'or:gemini-pro': { provider: 'openrouter', model_id: 'google/gemini-2.5-pro' },
  'or:llama-3.3-70b': { provider: 'openrouter', model_id: 'meta-llama/llama-3.3-70b-instruct' },
})

/**
 * Resolve a model identifier to a concrete `{ provider, model_id }`.
 *
 * 1. If `model` contains a colon and the prefix matches a known provider name,
 *    split on the FIRST colon only and return `{ provider, model_id }`. This
 *    lets OpenRouter ids like `openrouter:anthropic/claude-sonnet-4.5`
 *    round-trip without losing the upstream `provider/model` separator.
 * 2. Otherwise look up `model` in the alias table.
 * 3. Otherwise throw `model_not_found_error`.
 */
export function resolve_model(table: AliasTable, model: string): AliasTarget {
  const colon = model.indexOf(':')
  if (colon > 0) {
    const prefix = model.slice(0, colon)
    if (KNOWN_PROVIDERS.has(prefix)) {
      return { provider: prefix, model_id: model.slice(colon + 1) }
    }
  }
  const hit = table[model]
  if (hit !== undefined) return hit
  throw new model_not_found_error(model, Object.keys(table))
}

export function is_known_provider(name: string): boolean {
  return KNOWN_PROVIDERS.has(name)
}
