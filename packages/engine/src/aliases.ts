/**
 * Model resolution: two orthogonal axes.
 *
 *   model    - WHICH model. Either a family name (`opus`, `sonnet`, `gpt`,
 *              `gemini`) meaning "latest of that family", or a specific vendor
 *              id (`claude-opus-4-8`) meaning exactly that version.
 *   provider - HOW to reach it (the transport): `anthropic`, `claude_cli`,
 *              `openrouter`, `openai`, `google`, ...
 *
 * MODEL_FAMILIES maps a family to the latest id to send to each provider. Each
 * value is the most rolling token that provider offers: the Claude CLI resolves
 * `opus`/`sonnet`/`haiku` to the latest itself, so its entries are the bare
 * family token and never go stale; API-style providers need a concrete id, so
 * those entries are the single place to bump on a new release.
 *
 * MODEL_FAMILIES is frozen; per-engine overrides flow through engine config
 * (`families`) or the alias table, never via mutation of the defaults.
 */

import type { AliasTable, AliasTarget, FamilyCatalog } from './types.js'
import { model_family_unavailable_error } from './errors.js'

const KNOWN_PROVIDERS = new Set<string>([
  'anthropic',
  'openai',
  'google',
  'ollama',
  'lmstudio',
  'openrouter',
  'claude_cli',
])

export const MODEL_FAMILIES: FamilyCatalog = Object.freeze({
  opus: Object.freeze({
    anthropic: 'claude-opus-4-8',
    claude_cli: 'opus',
    openrouter: 'anthropic/claude-opus-4.8',
  }),
  sonnet: Object.freeze({
    anthropic: 'claude-sonnet-4-6',
    claude_cli: 'sonnet',
    openrouter: 'anthropic/claude-sonnet-4.5',
  }),
  haiku: Object.freeze({
    anthropic: 'claude-haiku-4-5',
    claude_cli: 'haiku',
    openrouter: 'anthropic/claude-haiku-4.5',
  }),

  gpt: Object.freeze({
    openai: 'gpt-4o',
    openrouter: 'openai/gpt-4o',
  }),
  'gpt-mini': Object.freeze({
    openai: 'gpt-4o-mini',
    openrouter: 'openai/gpt-4o-mini',
  }),

  gemini: Object.freeze({
    google: 'gemini-2.5-pro',
    openrouter: 'google/gemini-2.5-pro',
  }),
  'gemini-flash': Object.freeze({
    google: 'gemini-2.5-flash',
    openrouter: 'google/gemini-2.5-flash',
  }),
})

/**
 * Resolve a `(model, provider)` pair to a concrete `{ provider, model_id }`.
 *
 * 1. Colon-form `provider:id` (known provider prefix) splits on the FIRST
 *    colon and sets both axes at once. Preserves OpenRouter `provider/model`
 *    slugs and overrides the `provider` argument.
 * 2. A user-registered alias (`aliases`) returns its pinned target.
 * 3. A family name resolves to that family's latest id for `provider`; if the
 *    family has no entry for `provider`, throws `model_family_unavailable_error`.
 * 4. Anything else is a specific vendor id: passed through verbatim to
 *    `provider`. The vendor rejects a bogus id at call time.
 */
export function resolve_model(
  model: string,
  provider: string,
  ctx: { families: FamilyCatalog; aliases: AliasTable },
): AliasTarget {
  const colon = model.indexOf(':')
  if (colon > 0) {
    const prefix = model.slice(0, colon)
    if (KNOWN_PROVIDERS.has(prefix)) {
      return { provider: prefix, model_id: model.slice(colon + 1) }
    }
  }

  const alias = ctx.aliases[model]
  if (alias !== undefined) return alias

  const family = ctx.families[model]
  if (family !== undefined) {
    const model_id = family[provider]
    if (model_id === undefined) {
      throw new model_family_unavailable_error(model, provider, Object.keys(family))
    }
    return { provider, model_id }
  }

  return { provider, model_id: model }
}

export function is_known_provider(name: string): boolean {
  return KNOWN_PROVIDERS.has(name)
}
