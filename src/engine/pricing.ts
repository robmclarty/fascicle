/**
 * Pricing table and cost computation.
 *
 * DEFAULT_PRICING is frozen at module load. Per-engine overrides flow through
 * engine config or register_price; the defaults are never mutated.
 *
 * Cost math formula:
 *   input_usd        = (input_tokens - cached - cache_write) * input_per_million / 1e6
 *   cached_input_usd = cached                                * (cached_per_million ?? input_per_million) / 1e6
 *   cache_write_usd  = cache_write                           * (cache_write_per_million ?? input_per_million) / 1e6
 *   reasoning_usd    = reasoning                             * (reasoning_per_million   ?? output_per_million) / 1e6
 *   output_usd       = (output_tokens - reasoning)           * output_per_million / 1e6
 *
 * If reasoning_per_million is absent (the common case), reasoning tokens are
 * billed at the output rate and rolled into output_usd rather than surfacing
 * reasoning_usd separately.
 *
 * Fields on CostBreakdown are omitted (not zeroed) when the corresponding
 * usage field was 0 across the whole call. compute_cost is called per turn,
 * so it reports the fields that saw usage in THIS turn. The top-level
 * aggregation stage decides which fields to omit on the aggregated
 * CostBreakdown.
 */

import type { CostBreakdown, Pricing, PricingTable, UsageTotals } from './types.js'

export const FREE_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'lmstudio'])

export const DEFAULT_PRICING: PricingTable = Object.freeze({
  'anthropic:claude-opus-4-8': {
    input_per_million: 5.0,
    output_per_million: 25.0,
    cached_input_per_million: 0.5,
    cache_write_per_million: 6.25,
  },
  'anthropic:claude-opus-4-7': {
    input_per_million: 5.0,
    output_per_million: 25.0,
    cached_input_per_million: 0.5,
    cache_write_per_million: 6.25,
  },
  'anthropic:claude-opus-4-6': {
    input_per_million: 5.0,
    output_per_million: 25.0,
    cached_input_per_million: 0.5,
    cache_write_per_million: 6.25,
  },
  'anthropic:claude-sonnet-4-6': {
    input_per_million: 3.0,
    output_per_million: 15.0,
    cached_input_per_million: 0.3,
    cache_write_per_million: 3.75,
  },
  'anthropic:claude-haiku-4-5': {
    input_per_million: 1.0,
    output_per_million: 5.0,
    cached_input_per_million: 0.1,
    cache_write_per_million: 1.25,
  },

  'openai:gpt-4o': {
    input_per_million: 2.5,
    output_per_million: 10.0,
    cached_input_per_million: 1.25,
  },
  'openai:gpt-4o-mini': {
    input_per_million: 0.15,
    output_per_million: 0.6,
    cached_input_per_million: 0.075,
  },

  'google:gemini-2.5-pro': { input_per_million: 1.25, output_per_million: 5.0 },
  'google:gemini-2.5-flash': { input_per_million: 0.075, output_per_million: 0.3 },
})

/**
 * Build the `provider:model_id` key used to look up a pricing table entry.
 */
export function pricing_key(provider: string, model_id: string): string {
  return `${provider}:${model_id}`
}

/**
 * Round a dollar amount to 6 decimal places.
 *
 * Per-token rates produce long floating-point tails; 6 places keeps
 * sub-cent precision without leaking binary rounding noise into reports.
 */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/**
 * The breakdown for a turn whose model has no pricing entry.
 *
 * Free providers (ollama, lmstudio) still report an all-zero, estimated
 * breakdown; a priced provider missing a table entry returns undefined so the
 * caller can surface a `pricing_missing` event instead of a fake zero.
 */
function missing_pricing_breakdown(provider: string): CostBreakdown | undefined {
  if (!FREE_PROVIDERS.has(provider)) return undefined
  return {
    total_usd: 0,
    input_usd: 0,
    output_usd: 0,
    currency: 'USD',
    is_estimate: true,
  }
}

/**
 * Split reasoning tokens between a surfaced `reasoning_usd` field and the
 * output total.
 *
 * With a dedicated `reasoning_per_million` rate the reasoning cost is surfaced
 * separately and left out of output; without one it rolls into output at the
 * output rate. Absent reasoning tokens leave output untouched and surface
 * nothing.
 */
function apply_reasoning_cost(
  plain_output_usd_raw: number,
  reasoning: number,
  has_reasoning_rate: boolean,
  reasoning_usd_raw: number,
): { output_usd_raw: number; surface_reasoning_usd: number | undefined } {
  if (reasoning > 0) {
    if (has_reasoning_rate) {
      return { output_usd_raw: plain_output_usd_raw, surface_reasoning_usd: round6(reasoning_usd_raw) }
    }
    return {
      output_usd_raw: plain_output_usd_raw + reasoning_usd_raw,
      surface_reasoning_usd: undefined,
    }
  }
  return { output_usd_raw: plain_output_usd_raw, surface_reasoning_usd: undefined }
}

/**
 * Compute a CostBreakdown for a single turn's usage.
 *
 * Returns undefined when pricing is absent AND the provider is not free. Free
 * providers (ollama, lmstudio) return an all-zero breakdown even with no
 * pricing entry. Callers are responsible for deduplicating pricing_missing
 * trajectory events across turns within a single generate call.
 *
 * Fields are omitted (not zeroed) when the corresponding usage is 0 for the
 * input call.
 */
export function compute_cost(
  usage: UsageTotals,
  pricing: Pricing | undefined,
  provider: string,
): CostBreakdown | undefined {
  if (pricing === undefined) return missing_pricing_breakdown(provider)

  const cached = usage.cached_input_tokens ?? 0
  const cache_write = usage.cache_write_tokens ?? 0
  const reasoning = usage.reasoning_tokens ?? 0

  const fresh_input = Math.max(0, usage.input_tokens - cached - cache_write)
  const cached_rate = pricing.cached_input_per_million ?? pricing.input_per_million
  const cache_write_rate = pricing.cache_write_per_million ?? pricing.input_per_million
  const reasoning_rate = pricing.reasoning_per_million ?? pricing.output_per_million

  const input_usd_raw = (fresh_input * pricing.input_per_million) / 1e6
  const cached_usd_raw = (cached * cached_rate) / 1e6
  const cache_write_usd_raw = (cache_write * cache_write_rate) / 1e6
  const reasoning_usd_raw = (reasoning * reasoning_rate) / 1e6
  const plain_output_tokens = Math.max(0, usage.output_tokens - reasoning)
  const plain_output_usd_raw = (plain_output_tokens * pricing.output_per_million) / 1e6

  const { output_usd_raw, surface_reasoning_usd } = apply_reasoning_cost(
    plain_output_usd_raw,
    reasoning,
    pricing.reasoning_per_million !== undefined,
    reasoning_usd_raw,
  )

  const total_raw =
    input_usd_raw +
    cached_usd_raw +
    cache_write_usd_raw +
    (surface_reasoning_usd !== undefined ? reasoning_usd_raw : 0) +
    output_usd_raw

  const breakdown: CostBreakdown = {
    total_usd: round6(total_raw),
    input_usd: round6(input_usd_raw),
    output_usd: round6(output_usd_raw),
    currency: 'USD',
    is_estimate: true,
  }
  if (cached > 0) breakdown.cached_input_usd = round6(cached_usd_raw)
  if (cache_write > 0) breakdown.cache_write_usd = round6(cache_write_usd_raw)
  if (surface_reasoning_usd !== undefined) breakdown.reasoning_usd = surface_reasoning_usd
  return breakdown
}
