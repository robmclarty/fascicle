/**
 * Derived tokens-per-second over step timing.
 *
 * The engine stores timing primitives (StepTiming) and leaves the rate as a
 * derived view, because "tokens per second" has two legitimate readings. The
 * quoted-benchmark meaning is decode throughput: output tokens over the time
 * the model spent emitting them, which needs a streamed turn's first-chunk
 * stamp to isolate. Without streaming, the only measurable window is the whole
 * round-trip, which folds in network, provider queueing, and prompt prefill;
 * that blended rate understates the model on long prompts with short answers.
 * The result names which one it is rather than letting the two be confused.
 */

import type { GenerateResult, StepRecord } from './types.js'

export type Throughput = {
  /** Output tokens per second over the measured window. Not rounded. */
  tokens_per_second: number
  /**
   * 'decode' when every contributing step streamed, so each window excludes
   * its time-to-first-chunk; 'blended' when any window is a whole round-trip
   * (network + queueing + prefill included).
   */
  basis: 'decode' | 'blended'
  /** Output tokens summed across the contributing steps. */
  output_tokens: number
  /** The measured window in ms, summed across the contributing steps. */
  measured_ms: number
}

/**
 * Narrow the accepted source union to its array member. A user-defined guard
 * because Array.isArray does not narrow a ReadonlyArray union member on its
 * own.
 */
function is_step_list(
  source: GenerateResult<unknown> | StepRecord | ReadonlyArray<StepRecord>,
): source is ReadonlyArray<StepRecord> {
  return Array.isArray(source)
}

/**
 * Compute output throughput from step timing: a whole GenerateResult, a step
 * array, or a single step.
 *
 * Only steps carrying `timing` contribute; tool-execution time between turns
 * never does, since StepTiming brackets the provider round-trip alone. Each
 * step's window is `duration_ms - first_chunk_ms` when the turn streamed and
 * the full `duration_ms` otherwise, with `basis` reporting 'decode' only when
 * no blended window contributed. Returns undefined when nothing is measurable:
 * no step has timing (an external adapter, a test seam), or the summed window
 * is 0 ms (a sub-millisecond stub turn), where a rate would divide by zero.
 */
export function throughput(
  source: GenerateResult<unknown> | StepRecord | ReadonlyArray<StepRecord>,
): Throughput | undefined {
  const steps: ReadonlyArray<StepRecord> = is_step_list(source)
    ? source
    : 'steps' in source
      ? source.steps
      : [source]

  let output_tokens = 0
  let measured_ms = 0
  let all_decode = true
  for (const step of steps) {
    if (step.timing === undefined) continue
    output_tokens += step.usage.output_tokens
    if (step.timing.first_chunk_ms !== undefined) {
      measured_ms += step.timing.duration_ms - step.timing.first_chunk_ms
    } else {
      measured_ms += step.timing.duration_ms
      all_decode = false
    }
  }
  if (measured_ms <= 0) return undefined
  return {
    tokens_per_second: (output_tokens * 1000) / measured_ms,
    basis: all_decode ? 'decode' : 'blended',
    output_tokens,
    measured_ms,
  }
}
