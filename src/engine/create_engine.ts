/**
 * Engine factory.
 *
 * `create_engine` validates each provider entry at construction, merges user
 * pricing over DEFAULT_PRICING into a per-instance table, and returns an
 * Engine whose methods close over this instance state. Model resolution is a
 * verbatim pass-through: `model` is sent to the provider unchanged.
 */

import type {
  Engine,
  EngineConfig,
  GenerateOptions,
  GenerateResult,
  Pricing,
  PricingTable,
  ProviderConfigMap,
} from './types.js'
import { DEFAULT_PRICING, pricing_key } from './pricing.js'
import { DEFAULT_RETRY } from './retry.js'
import {
  engine_config_error,
  engine_disposed_error,
} from './errors.js'
import { get_provider_factory, list_builtin_providers } from './providers/registry.js'
import type { ProviderAdapter, ProviderFactory } from './providers/types.js'
import { generate, type EngineInternals } from './generate.js'

/**
 * Build the provider-name to adapter map from `providers`, resolving each
 * name to a `custom_providers` factory when one is supplied, or the built-in
 * registry factory otherwise.
 *
 * Each factory validates its init value synchronously, so a bad credential
 * throws here at construction time rather than later; loading the
 * underlying SDK is deferred until the first `generate` call. Throws if
 * `custom_providers` tries to shadow a built-in provider name.
 */
function build_provider_adapters(
  providers: EngineConfig['providers'],
  custom_providers: EngineConfig['custom_providers'],
): Map<string, ProviderAdapter> {
  if (custom_providers !== undefined) {
    const builtins = new Set(list_builtin_providers())
    for (const name of Object.keys(custom_providers)) {
      if (builtins.has(name)) {
        throw new engine_config_error(
          `custom_providers must not shadow built-in provider '${name}'`,
          name,
        )
      }
    }
  }
  const adapters = new Map<string, ProviderAdapter>()
  for (const [name, init] of Object.entries(providers)) {
    if (init === undefined) continue
    const custom =
      custom_providers !== undefined && Object.hasOwn(custom_providers, name)
        ? custom_providers[name]
        : undefined
    const factory = custom ?? get_provider_factory(name)
    const adapter = factory(init)
    adapters.set(name, adapter)
  }
  return adapters
}

/**
 * Validate `config` and construct an `Engine`.
 *
 * Provider entries are validated synchronously via `build_provider_adapters`.
 * A `generate` call that names a provider absent from `config.providers`
 * still throws `provider_not_configured_error`, but only at call time.
 */
export function create_engine(config: EngineConfig): Engine {
  if (
    config.providers === null ||
    typeof config.providers !== 'object'
  ) {
    throw new engine_config_error('EngineConfig.providers is required')
  }

  const adapters = build_provider_adapters(config.providers, config.custom_providers)

  const pricing: Record<string, Pricing> = { ...DEFAULT_PRICING }
  if (config.pricing !== undefined) {
    for (const [key, value] of Object.entries(config.pricing)) {
      pricing[key] = value
    }
  }

  const defaults = config.defaults
  // `config.defaults.*` is the current nested layer; `config.default_retry`,
  // `config.default_effort`, and `config.default_max_steps` are older
  // top-level fields kept for compatibility. Where both are set, the nested
  // `defaults` value wins, and the built-in constant is the last resort.
  const default_retry = defaults?.retry_policy ?? config.default_retry ?? DEFAULT_RETRY
  const default_effort = defaults?.effort ?? config.default_effort ?? 'none'
  const default_max_steps = defaults?.max_steps ?? config.default_max_steps ?? 10
  // Validated once here, at construction, rather than on every generate call
  // that ends up using the default: a bad default should fail fast instead
  // of surfacing deep inside the first call that needs it.
  if (defaults?.tool_call_repair_attempts !== undefined && defaults.tool_call_repair_attempts < 0) {
    throw new engine_config_error('defaults.tool_call_repair_attempts must be >= 0')
  }
  if (defaults?.max_tool_calls_per_step !== undefined && defaults.max_tool_calls_per_step < 1) {
    throw new engine_config_error('defaults.max_tool_calls_per_step must be >= 1')
  }
  if (defaults?.turn_timeout_ms !== undefined && defaults.turn_timeout_ms <= 0) {
    throw new engine_config_error('defaults.turn_timeout_ms must be > 0')
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
    ...(defaults?.turn_timeout_ms !== undefined
      ? { default_turn_timeout_ms: defaults.turn_timeout_ms }
      : {}),
    ...(defaults?.ai_sdk_telemetry !== undefined
      ? { default_ai_sdk_telemetry: defaults.ai_sdk_telemetry }
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
      // Defensive shallow copy: mutating the returned object does not affect
      // engine state.
      return { ...pricing }
    },
    with_providers(
      providers: ProviderConfigMap,
      custom_providers?: Record<string, ProviderFactory>,
    ): Engine {
      // Derives a NEW engine from the retained construction config:
      // `providers`/`custom_providers` shallow-merge by name over the
      // originals, the merged config is re-validated by a recursive
      // create_engine call (same validation, fresh adapters, independent
      // disposal), and this engine is left untouched. This is the
      // value-semantic way to add providers at runtime, not a mutable
      // registry.
      //
      // Since `...config` below already carries `config.custom_providers`
      // forward unconditionally, this merge only changes the result when the
      // `custom_providers` ARGUMENT contributes entries. That leaves a cluster of
      // genuine equivalents as documented survivors here, all rooted in the left
      // disjunct being redundant: mutating `config.custom_providers !== undefined`
      // (to `false`, or `!==` to `===`) only swaps `merged_custom` between
      // `undefined`, `{}`, and a shallow copy of `config.custom_providers`, and
      // given `...config` those build identical adapters; forcing the whole
      // condition true likewise yields `{}` for `undefined` when both are absent;
      // and forcing the spread-in below on always passes the `undefined` "no
      // customs" sentinel. A Stryker-disable can't fence these off: on the same
      // lines the whole-condition `false` and the right-disjunct mutants DO change
      // behavior, they drop a supplied argument, and the suite kills those.
      const merged_custom =
        config.custom_providers !== undefined || custom_providers !== undefined
          ? { ...config.custom_providers, ...custom_providers }
          : undefined
      return create_engine({
        ...config,
        providers: { ...config.providers, ...providers },
        ...(merged_custom !== undefined ? { custom_providers: merged_custom } : {}),
      })
    },
    dispose(): Promise<void> {
      if (dispose_promise !== undefined) return dispose_promise
      disposed = true
      // Stryker disable next-line ArrayDeclaration: seeding this accumulator
      // non-empty is observationally identical: every element is awaited by
      // the Promise.all below and then discarded by `.then(() => undefined)`,
      // so a stray value cannot change what dispose() resolves to or when.
      const tasks: Promise<void>[] = []
      for (const adapter of adapters.values()) {
        // Any adapter kind may hold resources: external always defines
        // dispose, native optionally (keep-alive agents, connection pools).
        if ('dispose' in adapter && adapter.dispose !== undefined) {
          tasks.push(adapter.dispose())
        }
      }
      dispose_promise = Promise.all(tasks).then(() => undefined)
      return dispose_promise
    },
  }

  return engine
}
