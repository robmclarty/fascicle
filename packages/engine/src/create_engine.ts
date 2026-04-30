/**
 * Engine factory (spec §5.8).
 *
 * create_engine validates each provider entry at construction, merges user
 * aliases / pricing over DEFAULT_ALIASES / DEFAULT_PRICING into per-instance
 * tables, and returns an Engine whose methods close over this instance state.
 *
 * Credentials / init values are validated synchronously by each provider
 * adapter factory; SDK loading is deferred to the first generate call. A
 * generate call that references a provider absent from the construction
 * providers map throws provider_not_configured_error at call time.
 *
 * list_aliases and list_prices return defensive shallow copies; mutating the
 * returned objects does not affect engine state.
 */

import type {
  AliasTable,
  AliasTarget,
  Engine,
  EngineConfig,
  GenerateOptions,
  GenerateResult,
  Pricing,
  PricingTable,
  ProviderInit,
} from './types.js'
import { DEFAULT_ALIASES } from './aliases.js'
import { DEFAULT_PRICING, pricing_key } from './pricing.js'
import { DEFAULT_RETRY } from './retry.js'
import {
  engine_config_error,
  engine_disposed_error,
  model_not_found_error,
} from './errors.js'
import { get_provider_factory } from './providers/registry.js'
import type { ProviderAdapter } from './providers/types.js'
import { generate, type EngineInternals } from './generate.js'

function build_provider_adapters(
  providers: EngineConfig['providers'],
): Map<string, ProviderAdapter> {
  const adapters = new Map<string, ProviderAdapter>()
  for (const [name, init] of Object.entries(providers)) {
    if (init === undefined) continue
    const factory = get_provider_factory(name)
    const adapter = factory(init as ProviderInit)
    adapters.set(name, adapter)
  }
  return adapters
}

export function create_engine(config: EngineConfig): Engine {
  if (
    config.providers === null ||
    typeof config.providers !== 'object'
  ) {
    throw new engine_config_error('EngineConfig.providers is required')
  }

  const adapters = build_provider_adapters(config.providers)

  const aliases: Record<string, AliasTarget> = { ...DEFAULT_ALIASES }
  if (config.aliases !== undefined) {
    for (const [name, target] of Object.entries(config.aliases)) {
      aliases[name] = target
    }
  }

  const pricing: Record<string, Pricing> = { ...DEFAULT_PRICING }
  if (config.pricing !== undefined) {
    for (const [key, value] of Object.entries(config.pricing)) {
      pricing[key] = value
    }
  }

  const defaults = config.defaults
  const default_retry = defaults?.retry_policy ?? config.default_retry ?? DEFAULT_RETRY
  const default_effort = defaults?.effort ?? config.default_effort ?? 'none'
  const default_max_steps = defaults?.max_steps ?? config.default_max_steps ?? 10

  const get_internals = (): EngineInternals => ({
    aliases,
    pricing,
    adapters,
    default_retry,
    default_effort,
    default_max_steps,
    ...(defaults?.model !== undefined ? { default_model: defaults.model } : {}),
    ...(defaults?.system !== undefined ? { default_system: defaults.system } : {}),
    ...(defaults?.tool_error_policy !== undefined
      ? { default_tool_error_policy: defaults.tool_error_policy }
      : {}),
    ...(defaults?.schema_repair_attempts !== undefined
      ? { default_schema_repair_attempts: defaults.schema_repair_attempts }
      : {}),
    ...(defaults?.provider_options !== undefined
      ? { default_provider_options: defaults.provider_options }
      : {}),
  })

  let disposed = false
  let dispose_promise: Promise<void> | undefined

  const engine: Engine = {
    generate<t = string>(opts: GenerateOptions<t>): Promise<GenerateResult<t>> {
      if (disposed) throw new engine_disposed_error()
      return generate<t>(opts, get_internals())
    },
    register_alias(alias: string, target: AliasTarget): void {
      aliases[alias] = target
    },
    unregister_alias(alias: string): void {
      delete aliases[alias]
    },
    resolve_alias(alias: string): AliasTarget {
      const hit = aliases[alias]
      if (hit === undefined) {
        throw new model_not_found_error(alias, Object.keys(aliases))
      }
      return hit
    },
    list_aliases(): AliasTable {
      return { ...aliases }
    },
    register_price(provider: string, model_id: string, value: Pricing): void {
      pricing[pricing_key(provider, model_id)] = value
    },
    resolve_price(provider: string, model_id: string): Pricing | undefined {
      return pricing[pricing_key(provider, model_id)]
    },
    list_prices(): PricingTable {
      return { ...pricing }
    },
    dispose(): Promise<void> {
      if (dispose_promise !== undefined) return dispose_promise
      disposed = true
      const tasks: Promise<void>[] = []
      for (const adapter of adapters.values()) {
        if (adapter.kind === 'subprocess') tasks.push(adapter.dispose())
      }
      dispose_promise = Promise.all(tasks).then(() => undefined)
      return dispose_promise
    },
  }

  return engine
}
