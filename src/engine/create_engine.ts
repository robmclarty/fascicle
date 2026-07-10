/**
 * Engine factory (spec §5.8).
 *
 * create_engine validates each provider entry at construction, merges user
 * pricing over DEFAULT_PRICING into a per-instance table, and returns an Engine
 * whose methods close over this instance state. Model resolution is a verbatim
 * pass-through: `model` is sent to the provider unchanged.
 *
 * Credentials / init values are validated synchronously by each provider
 * adapter factory; SDK loading is deferred to the first generate call. A
 * generate call that references a provider absent from the construction
 * providers map throws provider_not_configured_error at call time.
 *
 * list_prices returns a defensive shallow copy; mutating the returned object
 * does not affect engine state.
 */

import type {
  Engine,
  EngineConfig,
  GenerateOptions,
  GenerateResult,
  Pricing,
  PricingTable,
} from './types.js'
import { DEFAULT_PRICING, pricing_key } from './pricing.js'
import { DEFAULT_RETRY } from './retry.js'
import {
  engine_config_error,
  engine_disposed_error,
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
    const adapter = factory(init)
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
  if (defaults?.tool_call_repair_attempts !== undefined && defaults.tool_call_repair_attempts < 0) {
    throw new engine_config_error('defaults.tool_call_repair_attempts must be >= 0')
  }
  if (defaults?.max_tool_calls_per_step !== undefined && defaults.max_tool_calls_per_step < 1) {
    throw new engine_config_error('defaults.max_tool_calls_per_step must be >= 1')
  }

  const get_internals = (): EngineInternals => ({
    pricing,
    adapters,
    default_retry,
    default_effort,
    default_max_steps,
    ...(defaults?.model !== undefined ? { default_model: defaults.model } : {}),
    ...(defaults?.provider !== undefined ? { default_provider: defaults.provider } : {}),
    ...(defaults?.system !== undefined ? { default_system: defaults.system } : {}),
    ...(defaults?.tool_error_policy !== undefined
      ? { default_tool_error_policy: defaults.tool_error_policy }
      : {}),
    ...(defaults?.schema_repair_attempts !== undefined
      ? { default_schema_repair_attempts: defaults.schema_repair_attempts }
      : {}),
    ...(defaults?.tool_call_repair_attempts !== undefined
      ? { default_tool_call_repair_attempts: defaults.tool_call_repair_attempts }
      : {}),
    ...(defaults?.max_tool_calls_per_step !== undefined
      ? { default_max_tool_calls_per_step: defaults.max_tool_calls_per_step }
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
