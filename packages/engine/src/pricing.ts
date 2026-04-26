/**
 * Pricing table and cost computation.
 *
 * DEFAULT_PRICING is frozen at module load. Per-engine overrides flow through
 * engine config or register_price; the defaults are never mutated.
 *
 * Cost math formula (spec §5.10):
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
 * usage field was 0 across the whole call: see §5.10 / F17. compute_cost is
 * called per-turn, so it reports the fields that saw usage in THIS turn. The
 * top-level aggregation stage is responsible for deciding which fields to
 * omit on the aggregated CostBreakdown.
 */

import type { CostBreakdown, Pricing, PricingTable, UsageTotals } from './types.js';

export const FREE_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'lmstudio']);

export const DEFAULT_PRICING: PricingTable = Object.freeze({
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
});

export function pricing_key(provider: string, model_id: string): string {
  return `${provider}:${model_id}`;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
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
  if (pricing === undefined) {
    if (!FREE_PROVIDERS.has(provider)) return undefined;
    const breakdown: CostBreakdown = {
      total_usd: 0,
      input_usd: 0,
      output_usd: 0,
      currency: 'USD',
      is_estimate: true,
    };
    return breakdown;
  }

  const input_tokens = usage.input_tokens;
  const output_tokens = usage.output_tokens;
  const cached = usage.cached_input_tokens ?? 0;
  const cache_write = usage.cache_write_tokens ?? 0;
  const reasoning = usage.reasoning_tokens ?? 0;

  const fresh_input = Math.max(0, input_tokens - cached - cache_write);
  const cached_rate = pricing.cached_input_per_million ?? pricing.input_per_million;
  const cache_write_rate = pricing.cache_write_per_million ?? pricing.input_per_million;
  const has_reasoning_rate = pricing.reasoning_per_million !== undefined;
  const reasoning_rate = pricing.reasoning_per_million ?? pricing.output_per_million;

  const input_usd_raw = (fresh_input * pricing.input_per_million) / 1e6;
  const cached_usd_raw = (cached * cached_rate) / 1e6;
  const cache_write_usd_raw = (cache_write * cache_write_rate) / 1e6;
  const reasoning_usd_raw = (reasoning * reasoning_rate) / 1e6;
  const plain_output_tokens = Math.max(0, output_tokens - reasoning);
  const plain_output_usd_raw = (plain_output_tokens * pricing.output_per_million) / 1e6;

  const input_usd = round6(input_usd_raw);

  let output_usd_raw = plain_output_usd_raw;
  let surface_reasoning_usd: number | undefined;
  if (reasoning > 0) {
    if (has_reasoning_rate) {
      surface_reasoning_usd = round6(reasoning_usd_raw);
    } else {
      output_usd_raw = plain_output_usd_raw + reasoning_usd_raw;
    }
  }
  const output_usd = round6(output_usd_raw);

  let cached_input_usd: number | undefined;
  let cache_write_usd: number | undefined;
  if (cached > 0) cached_input_usd = round6(cached_usd_raw);
  if (cache_write > 0) cache_write_usd = round6(cache_write_usd_raw);

  const total_raw =
    input_usd_raw +
    cached_usd_raw +
    cache_write_usd_raw +
    (surface_reasoning_usd !== undefined ? reasoning_usd_raw : 0) +
    output_usd_raw;

  const breakdown: CostBreakdown = {
    total_usd: round6(total_raw),
    input_usd,
    output_usd,
    currency: 'USD',
    is_estimate: true,
  };
  if (cached_input_usd !== undefined) breakdown.cached_input_usd = cached_input_usd;
  if (cache_write_usd !== undefined) breakdown.cache_write_usd = cache_write_usd;
  if (surface_reasoning_usd !== undefined) breakdown.reasoning_usd = surface_reasoning_usd;
  return breakdown;
}
