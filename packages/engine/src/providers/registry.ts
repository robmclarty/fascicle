/**
 * Provider name → adapter factory lookup.
 *
 * Unknown provider names throw provider_not_configured_error. The registry is
 * a frozen Map; runtime provider registration beyond the built-in set is
 * deferred (spec §5.9).
 */

import { provider_not_configured_error } from '../errors.js';
import type { ProviderFactory } from './types.js';
import { create_anthropic_adapter } from './anthropic.js';
import { create_openai_adapter } from './openai.js';
import { create_google_adapter } from './google.js';
import { create_ollama_adapter } from './ollama.js';
import { create_lmstudio_adapter } from './lmstudio.js';
import { create_openrouter_adapter } from './openrouter.js';
import { create_claude_cli_adapter } from './claude_cli/index.js';

const BUILTIN_PROVIDERS: ReadonlyMap<string, ProviderFactory> = new Map<string, ProviderFactory>([
  ['anthropic', create_anthropic_adapter],
  ['openai', create_openai_adapter],
  ['google', create_google_adapter],
  ['ollama', create_ollama_adapter],
  ['lmstudio', create_lmstudio_adapter],
  ['openrouter', create_openrouter_adapter],
  ['claude_cli', create_claude_cli_adapter],
]);

export function list_builtin_providers(): ReadonlyArray<string> {
  return [...BUILTIN_PROVIDERS.keys()];
}

export function get_provider_factory(name: string): ProviderFactory {
  const factory = BUILTIN_PROVIDERS.get(name);
  if (factory === undefined) throw new provider_not_configured_error(name);
  return factory;
}
