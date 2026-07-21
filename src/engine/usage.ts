/**
 * Usage aggregation across a generate call's steps.
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

/**
 * Sum token usage across every step of a generate call.
 *
 * `input_tokens` and `output_tokens` always total. The optional fields
 * (`reasoning_tokens`, `cached_input_tokens`, `cache_write_tokens`) stay
 * absent on the result unless at least one step reported them; once
 * present, every step contributes to the sum, with steps that omit the
 * field counting as 0.
 */
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
