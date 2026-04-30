/**
 * Usage aggregation.
 *
 * Absent fields stay absent on the aggregated total if no step reported them
 * at all. Fields present on any step are summed with absent values contributing
 * 0 for arithmetic purposes (spec §5.3).
 */

import type { StepRecord, UsageTotals } from './types.js'

type OptionalFieldKey =
  | 'reasoning_tokens'
  | 'cached_input_tokens'
  | 'cache_write_tokens'

const OPTIONAL_FIELDS: ReadonlyArray<OptionalFieldKey> = [
  'reasoning_tokens',
  'cached_input_tokens',
  'cache_write_tokens',
]

export function sum_usage(steps: ReadonlyArray<StepRecord>): UsageTotals {
  let input_tokens = 0
  let output_tokens = 0
  const present: Record<OptionalFieldKey, boolean> = {
    reasoning_tokens: false,
    cached_input_tokens: false,
    cache_write_tokens: false,
  }
  const sums: Record<OptionalFieldKey, number> = {
    reasoning_tokens: 0,
    cached_input_tokens: 0,
    cache_write_tokens: 0,
  }
  for (const step of steps) {
    input_tokens += step.usage.input_tokens
    output_tokens += step.usage.output_tokens
    for (const key of OPTIONAL_FIELDS) {
      const value = step.usage[key]
      if (value !== undefined) {
        present[key] = true
        sums[key] += value
      }
    }
  }

  const total: UsageTotals = { input_tokens, output_tokens }
  for (const key of OPTIONAL_FIELDS) {
    if (present[key]) total[key] = sums[key]
  }
  return total
}
