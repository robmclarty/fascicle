/**
 * make_capture_engine: an `Engine` that records every generate call.
 *
 * Returns the engine together with the live `calls` array, which receives
 * the `GenerateOptions` of each call in order. Every call resolves with the
 * same canned result (`options.result`, or a minimal `'ok'` result), so the
 * double is for asserting what reached the engine, not for scripting
 * multi-role conversations: that is `make_stub_engine`'s job.
 *
 * `options.on_generate` runs after the call is recorded and is awaited
 * before the result resolves, which is the hook for driving streaming
 * chunks, spans, or aborts against the captured options.
 */

import type { Engine, GenerateOptions, GenerateResult } from '#engine'
import { engine_from_generate } from './engine_from_generate.js'

export type CaptureEngineOptions = {
  readonly result?: GenerateResult<unknown>
  readonly on_generate?: (opts: GenerateOptions) => Promise<void> | void
}

export type CaptureEngine = {
  readonly engine: Engine
  readonly calls: GenerateOptions[]
}

const DEFAULT_RESULT: GenerateResult<unknown> = {
  content: 'ok',
  tool_calls: [],
  steps: [],
  usage: { input_tokens: 1, output_tokens: 1 },
  finish_reason: 'stop',
  model_resolved: { provider: 'stub', model_id: 'capture' },
}

/**
 * Build an `Engine` that records each call's `GenerateOptions` into the
 * returned `calls` array and answers with the canned result.
 */
export function make_capture_engine(options: CaptureEngineOptions = {}): CaptureEngine {
  const calls: GenerateOptions[] = []
  const result = options.result ?? DEFAULT_RESULT

  const engine = engine_from_generate(
    async <t = string>(opts: GenerateOptions<t>): Promise<GenerateResult<t>> => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const loose = opts as GenerateOptions
      calls.push(loose)
      if (options.on_generate) await options.on_generate(loose)
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return result as GenerateResult<t>
    },
  )
  return { engine, calls }
}
