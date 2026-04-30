/**
 * Shared provider-adapter shape.
 *
 * Each file under packages/engine/src/providers/ exports a factory that
 * accepts a ProviderInit shape and returns a ProviderAdapter. Factories are
 * synchronous; build_model is async so SDK loading is deferred until a model
 * is actually needed. Missing peer dependencies surface as engine_config_error
 * on first build_model call with a clear message naming the missing peer.
 *
 * Invariant 13: only generate.ts, tool_loop.ts, and index.ts may invoke
 * generateText/streamText from `ai` directly. Adapters build the provider
 * model and translate parameters; they do not orchestrate the call.
 */

import type {
  AliasTarget,
  EffortLevel,
  GenerateOptions,
  GenerateResult,
  ProviderInit,
  UsageTotals,
} from '../types.js'

export type EffortTranslation = {
  provider_options: Record<string, unknown>
  effort_ignored: boolean
}

export type ProviderCapability =
  | 'text'
  | 'tools'
  | 'schema'
  | 'streaming'
  | 'image_input'
  | 'reasoning'

export type RawProviderUsage = {
  input_tokens?: number
  output_tokens?: number
  reasoning_tokens?: number
  cached_input_tokens?: number
  cache_write_tokens?: number
  // Vercel AI SDK v6 also surfaces details via *Details containers; adapters
  // accept the flattened shape above for testability.
  input_token_details?: {
    cached_tokens?: number
    cache_creation_input_tokens?: number
  }
  output_token_details?: {
    reasoning_tokens?: number
  }
  [k: string]: unknown
}

export type AiSdkProviderAdapter = {
  readonly kind: 'ai_sdk'
  readonly name: string
  readonly build_model: (model_id: string) => Promise<unknown>
  readonly translate_effort: (effort: EffortLevel) => EffortTranslation
  readonly normalize_usage: (raw: RawProviderUsage | undefined) => UsageTotals
  readonly supports: (capability: ProviderCapability) => boolean
}

export type SubprocessProviderAdapter = {
  readonly kind: 'subprocess'
  readonly name: string
  readonly generate: <t>(
    opts: GenerateOptions<t>,
    resolved: AliasTarget,
  ) => Promise<GenerateResult<t>>
  readonly dispose: () => Promise<void>
  readonly supports: (capability: ProviderCapability) => boolean
}

export type ProviderAdapter = AiSdkProviderAdapter | SubprocessProviderAdapter

export type ProviderFactory = (init: ProviderInit) => ProviderAdapter

export function default_normalize_usage(
  raw: RawProviderUsage | undefined,
): UsageTotals {
  if (raw === undefined) return { input_tokens: 0, output_tokens: 0 }
  const input_tokens = typeof raw.input_tokens === 'number' ? raw.input_tokens : 0
  const output_tokens = typeof raw.output_tokens === 'number' ? raw.output_tokens : 0
  const totals: UsageTotals = { input_tokens, output_tokens }
  if (typeof raw.reasoning_tokens === 'number') totals.reasoning_tokens = raw.reasoning_tokens
  else if (typeof raw.output_token_details?.reasoning_tokens === 'number') {
    totals.reasoning_tokens = raw.output_token_details.reasoning_tokens
  }
  if (typeof raw.cached_input_tokens === 'number') totals.cached_input_tokens = raw.cached_input_tokens
  else if (typeof raw.input_token_details?.cached_tokens === 'number') {
    totals.cached_input_tokens = raw.input_token_details.cached_tokens
  }
  if (typeof raw.cache_write_tokens === 'number') totals.cache_write_tokens = raw.cache_write_tokens
  else if (typeof raw.input_token_details?.cache_creation_input_tokens === 'number') {
    totals.cache_write_tokens = raw.input_token_details.cache_creation_input_tokens
  }
  return totals
}

export async function load_optional_peer<t>(
  specifier: string,
): Promise<t> {
  let mod: unknown
  try {
    mod = await import(specifier)
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : JSON.stringify(err)
    const message =
      `missing peer dependency '${specifier}'. Install it with: pnpm add ${specifier}. Cause: ${detail}`
    throw new Error(message, { cause: err })
  }
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return mod as t
}
