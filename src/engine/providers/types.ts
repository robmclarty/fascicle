/**
 * Shared provider-adapter shape.
 *
 * Each file under src/engine/providers/ exports a factory that accepts a
 * ProviderInit shape and returns a ProviderAdapter. Factories are
 * synchronous; build_model is async so SDK loading is deferred until a model
 * is actually needed. Missing peer dependencies surface as engine_config_error
 * on first build_model call with a clear message naming the missing peer.
 *
 * Only the ai_sdk transport module (providers/ai_sdk/invoke.ts) may import
 * from `ai` or invoke generateText/streamText. ai_sdk adapters build the
 * provider model and translate parameters; they do not orchestrate the call.
 */

import type {
  ResolvedModel,
  EffortLevel,
  GenerateOptions,
  GenerateResult,
  ProviderInit,
  TurnRequest,
  TurnResult,
  UsageTotals,
} from '../types.js'
import { engine_config_error } from '../errors.js'

/**
 * Which backend a provider factory returns: 'ai_sdk' wraps the Vercel AI SDK
 * provider package, 'native' talks to the provider's HTTP API directly. The
 * provider name stays the same across transports so pricing keys and usage
 * fields carry over; only the wire implementation changes.
 */
export type ProviderTransport = 'ai_sdk' | 'native'

/**
 * Read the `transport` selector off a provider init. Defaults to 'ai_sdk';
 * anything but the two known backends throws at construction so a typo
 * fails loud instead of silently running the default.
 */
export function resolve_transport(
  init: ProviderInit,
  provider: string,
): ProviderTransport {
  const raw = init['transport']
  if (raw === undefined || raw === 'ai_sdk') return 'ai_sdk'
  if (raw === 'native') return 'native'
  throw new engine_config_error(
    `${provider} provider: transport must be 'ai_sdk' or 'native', got ${JSON.stringify(raw)}`,
    provider,
  )
}

export type EffortTranslation = {
  // Outer keys are provider names, inner records hold per-provider settings,
  // matching the two-level shape merge_provider_options expects.
  provider_options: Record<string, Record<string, unknown>>
  effort_ignored: boolean
}

export type ProviderCapability =
  | 'text'
  | 'tools'
  | 'schema'
  | 'streaming'
  | 'image_input'
  | 'reasoning'
  // Provider performs native constrained decoding (the AI SDK responseFormat /
  // Output.object path), as opposed to the prompt-for-JSON-then-extract path.
  // Distinct from 'schema': every provider can satisfy a schema via repair, but
  // only some constrain the decode to it.
  | 'structured_output'

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

/**
 * Raw-HTTP transport: implements a single turn against a provider's own
 * API with zero `ai` / `@ai-sdk/*` in its module graph. generate.ts wraps
 * invoke_turn in retry + classification + abort, so a native adapter owns only
 * request/response mapping (and streaming via TurnRequest.dispatch_chunk); it
 * MUST NOT implement its own retry. classify_error optionally overrides the
 * shared classifier; dispose is optional (keep-alive agents, connection pools).
 */
export type NativeProviderAdapter = {
  readonly kind: 'native'
  readonly name: string
  readonly invoke_turn: (req: TurnRequest) => Promise<TurnResult>
  readonly supports: (capability: ProviderCapability) => boolean
  readonly dispose?: () => Promise<void>
  readonly classify_error?: (err: unknown) => unknown
}

export type ExternalAgentAdapter = {
  readonly kind: 'external'
  readonly name: string
  readonly generate: <t>(
    opts: GenerateOptions<t>,
    resolved: ResolvedModel,
  ) => Promise<GenerateResult<t>>
  readonly dispose: () => Promise<void>
  readonly supports: (capability: ProviderCapability) => boolean
}

export type ProviderAdapter =
  | AiSdkProviderAdapter
  | NativeProviderAdapter
  | ExternalAgentAdapter

export type ProviderFactory = (init: ProviderInit) => ProviderAdapter

/**
 * Map raw provider usage to UsageTotals, the mapper most adapters share.
 *
 * Missing usage zeroes the totals. Optional fields (reasoning and cache
 * tokens) are set only when the raw payload carries them, reading the
 * flattened field first and the AI SDK's *_details container second.
 */
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

/**
 * Dynamically import an optional peer dependency, rethrowing an import
 * failure as an error that names the package and the install command so a
 * missing peer is diagnosable from the message alone.
 */
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
