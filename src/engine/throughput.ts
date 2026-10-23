/**
 * Derived tokens-per-second over step timing.
 *
 * The engine stores timing primitives (StepTiming) and leaves the rate as a
 * derived view, because "tokens per second" has two legitimate readings. The
 * quoted-benchmark meaning is decode throughput: output tokens over the time
 * the model spent emitting them. A provider that measures that time itself
 * gives it exactly, and Ollama reports it on every step. Anywhere else a
 * streamed turn's first-chunk stamp isolates it, as long as the turn streams
 * its output while it generates it, and every native turn streams, so those
 * measure 'decode'. Without streaming (claude_cli, an ai_sdk turn with no
 * consumer, or a native adapter that doesn't stream), the only measurable
 * window is the whole round-trip, which folds in network, provider queueing,
 * and prompt prefill; that blended rate understates the model on long prompts
 * with short answers. The result names which one it is rather than letting
 * the two be confused.
 */

import type { GenerateResult, StepRecord } from './types.js'

export type Throughput = {
  /** Output tokens per second over the measured window. Not rounded. */
  tokens_per_second: number
  /**
   * 'decode' when every contributing window is time the model spent emitting
   * output, either a decode time the provider reported or a streamed turn's
   * window after its first chunk; 'blended' when any window is a whole
   * round-trip (network + queueing + prefill included).
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
 * The decode time that the provider measured for a step itself, in ms, or
 * undefined when it reported none.
 *
 * Ollama is the one provider that reports it: `eval_duration` is the
 * nanoseconds the daemon spent generating the step's output, and it lands on
 * `provider_reported.ollama` on either transport. It holds where the stamp
 * can't, because a turn that's only a tool call dispatches nothing until it
 * has finished generating, and its streamed window is the last few
 * milliseconds of the turn.
 */
function reported_decode_ms(step: StepRecord): number | undefined {
  const ollama = step.provider_reported?.['ollama']
  if (typeof ollama !== 'object' || ollama === null) return undefined
  const eval_duration: unknown = Reflect.get(ollama, 'eval_duration')
  return typeof eval_duration === 'number' && eval_duration > 0 ? eval_duration / 1e6 : undefined
}

/**
 * One step's measured window and whether it is decode time, or undefined
 * when the step has nothing to measure. A decode time the provider reported
 * wins over the engine's own timing, streamed or not.
 */
function step_window(step: StepRecord): { ms: number; decode: boolean } | undefined {
  const reported = reported_decode_ms(step)
  if (reported !== undefined) return { ms: reported, decode: true }
  if (step.timing === undefined) return undefined
  const { duration_ms, first_chunk_ms } = step.timing
  if (first_chunk_ms === undefined) return { ms: duration_ms, decode: false }
  return { ms: duration_ms - first_chunk_ms, decode: true }
}

/**
 * Compute output throughput from step timing: a whole GenerateResult, a step
 * array, or a single step.
 *
 * Tool-execution time between turns never contributes, since StepTiming
 * brackets the provider round-trip alone. Each step's window is the decode
 * time its provider reported when it has one (Ollama's `eval_duration`),
 * else `duration_ms - first_chunk_ms` when the turn streamed, else the full
 * `duration_ms`, with `basis` reporting 'decode' only when no blended window
 * contributed. Returns undefined when nothing is measurable: no step has
 * timing or a reported decode time (an external adapter, a test seam), or the
 * summed window is 0 ms (a sub-millisecond stub turn), where a rate would
 * divide by zero.
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
    const window = step_window(step)
    if (window === undefined) continue
    output_tokens += step.usage.output_tokens
    measured_ms += window.ms
    if (!window.decode) all_decode = false
  }
  if (measured_ms <= 0) return undefined
  return {
    tokens_per_second: (output_tokens * 1000) / measured_ms,
    basis: all_decode ? 'decode' : 'blended',
    output_tokens,
    measured_ms,
  }
}
