/**
 * pipe: transform output.
 *
 * `pipe(inner, fn)` runs `inner`, passes its output to `fn`, returns `fn`'s
 * result. Use for shape adaptation when composing heterogeneous steps.
 */

import { is_step } from './is_step.js'
import { dispatch_step, register_traced_kind } from './runner.js'
import type { RunContext, Step } from './types.js'

let pipe_counter = 0

/**
 * Generate a unique step id of the form `pipe_<n>`.
 */
function next_id(): string {
  pipe_counter += 1
  return `pipe_${pipe_counter}`
}

export type PipeOptions = {
  readonly name?: string
}

/**
 * Build an output-transforming step around `inner`.
 *
 * The argument checks reject Steps passed where functions belong: `pipe` is
 * not variadic, and the early `TypeError`s point misuse at `step(fn)` or
 * `sequence([...])` instead of failing obscurely at run time.
 */
export function pipe<i, a, b>(
  inner: Step<i, a>,
  fn: (value: a) => b | Promise<b>,
  options?: PipeOptions,
): Step<i, b> {
  if (!is_step(inner)) {
    const hint = typeof inner === 'function' ? ' — wrap plain functions with step(fn)' : ''
    throw new TypeError(`pipe(inner, fn): inner must be a Step, got ${typeof inner}${hint}`)
  }
  if (typeof fn !== 'function') {
    if (is_step(fn)) {
      throw new TypeError(
        'pipe(inner, fn): fn must be a function, got a Step — pipe is not variadic; to chain Steps use sequence([...])',
      )
    }
    throw new TypeError(`pipe(inner, fn): fn must be a function, got ${typeof fn}`)
  }
  if (is_step(options)) {
    throw new TypeError(
      'pipe(inner, fn, options): got a Step as the third argument — pipe is not variadic; to chain Steps use sequence([...])',
    )
  }

  const id = next_id()

  const run_fn = async (input: i, ctx: RunContext): Promise<b> => {
    const intermediate = await dispatch_step(inner, input, ctx)
    return fn(intermediate)
  }

  const config_meta: Record<string, unknown> = { fn }
  if (options?.name !== undefined) config_meta['display_name'] = options.name

  return {
    id,
    kind: 'pipe',
    children: [inner],
    config: config_meta,
    run: run_fn,
  }
}

register_traced_kind('pipe')
