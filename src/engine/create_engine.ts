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
  EngineDefaults,
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
 * Mutable draft of a deeply `readonly` type, used to assemble an object field
 * by field before returning it under its public, frozen-looking type.
 */
type Writable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Seed a fresh, mutable pricing table from DEFAULT_PRICING and layer any
 * per-engine `config.pricing` overrides on top.
 *
 * The result is the engine's own table: register_price mutates it in place,
 * and DEFAULT_PRICING (frozen at module load) is never touched.
 */
function merge_pricing(overrides: EngineConfig['pricing']): Record<string, Pricing> {
  const pricing: Record<string, Pricing> = { ...DEFAULT_PRICING }
  if (overrides !== undefined) {
    for (const [key, value] of Object.entries(overrides)) {
      pricing[key] = value
    }
  }
  return pricing
}

/**
 * Resolve the three always-present scalar defaults.
 *
 * `config.defaults.*` is the current nested layer; `config.default_retry`,
 * `config.default_effort`, and `config.default_max_steps` are older top-level
 * fields kept for compatibility. The nested value wins where both are set, and
 * the built-in constant is the last resort.
 */
function resolve_default_scalars(
  config: EngineConfig,
): Pick<EngineInternals, 'default_retry' | 'default_effort' | 'default_max_steps'> {
  const defaults: EngineDefaults = config.defaults ?? {}
  return {
    default_retry: defaults.retry_policy ?? config.default_retry ?? DEFAULT_RETRY,
    default_effort: defaults.effort ?? config.default_effort ?? 'none',
    default_max_steps: defaults.max_steps ?? config.default_max_steps ?? 10,
  }
}

/**
 * Validate the numeric defaults once, at construction: a bad bound should fail
 * fast here rather than surfacing deep inside the first generate call that ends
 * up using the default.
 */
function validate_numeric_defaults(defaults: EngineDefaults | undefined): void {
  if (defaults === undefined) return
  const { tool_call_repair_attempts, max_tool_calls_per_step, turn_timeout_ms } = defaults
  if (tool_call_repair_attempts !== undefined && tool_call_repair_attempts < 0) {
    throw new engine_config_error(
      `defaults.tool_call_repair_attempts must be >= 0, got ${String(tool_call_repair_attempts)}`,
    )
  }
  if (max_tool_calls_per_step !== undefined && max_tool_calls_per_step < 1) {
    throw new engine_config_error(
      `defaults.max_tool_calls_per_step must be >= 1, got ${String(max_tool_calls_per_step)}`,
    )
  }
  if (turn_timeout_ms !== undefined && turn_timeout_ms <= 0) {
    throw new engine_config_error(`defaults.turn_timeout_ms must be > 0, got ${String(turn_timeout_ms)}`)
  }
}

/**
 * Copy `value` onto `target[key]` only when it is defined, so an absent optional
 * default leaves the key off the object rather than present-as-undefined.
 */
function assign_if_present<T, K extends keyof T>(target: T, key: K, value: T[K]): void {
  if (value !== undefined) target[key] = value
}

/**
 * Assemble the per-instance EngineInternals from the resolved required fields
 * plus whichever optional `defaults.*` knobs were supplied.
 *
 * The optional defaults form a fixed source-to-target table (`defaults.model` ->
 * `default_model`, and so on); each is folded in only when present, matching the
 * conditional-spread shape this replaced.
 */
function build_internals(
  base: Pick<
    EngineInternals,
    'pricing' | 'adapters' | 'default_retry' | 'default_effort' | 'default_max_steps'
  >,
  defaults: EngineDefaults | undefined,
): EngineInternals {
  const internals: Writable<EngineInternals> = {
    pricing: base.pricing,
    adapters: base.adapters,
    default_retry: base.default_retry,
    default_effort: base.default_effort,
    default_max_steps: base.default_max_steps,
  }
  if (defaults !== undefined) {
    assign_if_present(internals, 'default_model', defaults.model)
    assign_if_present(internals, 'default_provider', defaults.provider)
    assign_if_present(internals, 'default_system', defaults.system)
    assign_if_present(internals, 'default_temperature', defaults.temperature)
    assign_if_present(internals, 'default_max_tokens', defaults.max_tokens)
    assign_if_present(internals, 'default_top_p', defaults.top_p)
    assign_if_present(internals, 'default_tool_error_policy', defaults.tool_error_policy)
    assign_if_present(internals, 'default_schema_repair_attempts', defaults.schema_repair_attempts)
    assign_if_present(
      internals,
      'default_tool_call_repair_attempts',
      defaults.tool_call_repair_attempts,
    )
    assign_if_present(internals, 'default_max_tool_calls_per_step', defaults.max_tool_calls_per_step)
    assign_if_present(internals, 'default_turn_timeout_ms', defaults.turn_timeout_ms)
    assign_if_present(internals, 'default_ai_sdk_telemetry', defaults.ai_sdk_telemetry)
    assign_if_present(internals, 'default_provider_options', defaults.provider_options)
  }
  return internals
}

/**
 * Validate `config` and construct an `Engine`.
 *
 * Provider entries are validated synchronously via `build_provider_adapters`.
 * A `generate` call that names a provider absent from `config.providers`
 * still throws `provider_not_configured_error`, but only at call time.
 */
export function create_engine(config: EngineConfig): Engine {
  if (config.providers === null || typeof config.providers !== 'object') {
    throw new engine_config_error('EngineConfig.providers is required')
  }

  const adapters = build_provider_adapters(config.providers, config.custom_providers)
  const pricing = merge_pricing(config.pricing)
  const { default_retry, default_effort, default_max_steps } = resolve_default_scalars(config)
  validate_numeric_defaults(config.defaults)

  const get_internals = (): EngineInternals =>
    build_internals(
      { pricing, adapters, default_retry, default_effort, default_max_steps },
      config.defaults,
    )

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
