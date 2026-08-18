/**
 * parallel: concurrent execution of named children.
 *
 * `parallel({ a, b })` runs a and b concurrently with the same input. Output
 * is an object keyed by the child name; all children must accept the same
 * input type.
 *
 * Cancellation: each child runs with a composed abort signal,
 * `AbortSignal.any([ctx.abort, child_local])`. On abort the composer awaits
 * all in-flight children (success, failure, or aborted) before rethrowing
 * `ctx.abort.reason`.
 *
 * When several children fail, a `suspended_error` is preferred over an
 * application error so a human-approval gate inside a branch stays resumable
 * rather than being masked by a sibling's failure. Otherwise the first error
 * in declared order propagates.
 */

import { suspended_error } from './errors.js'
import { dispatch_step, install_abort_fan_out, register_traced_kind, throw_if_aborted } from './runner.js'
import type { AnyStep, RunContext, Step, StepInput, StepOutput } from './types.js'

// Distributes the union of member inputs into an intersection: the parallel
// step's input must satisfy every child, since each receives it verbatim.
type UnionToIntersection<u> = (u extends unknown ? (x: u) => void : never) extends (
  x: infer i,
) => void
  ? i
  : never

type ParallelInput<children extends Record<string, AnyStep>> = UnionToIntersection<
  StepInput<children[keyof children]>
>

type ParallelOutputs<children extends Record<string, AnyStep>> = {
  [k in keyof children]: StepOutput<children[k]>
}

let parallel_counter = 0

/**
 * Generate a unique step id of the form `parallel_<n>`.
 */
function next_id(): string {
  parallel_counter += 1
  return `parallel_${parallel_counter}`
}

type Settled =
  | { readonly status: 'ok'; readonly key: string; readonly value: unknown }
  | { readonly status: 'err'; readonly key: string; readonly err: unknown }

/**
 * Run one child under its own composed abort signal and settle it: an
 * `'ok'`/`'err'` record rather than a thrown error, so a sibling's failure
 * never short-circuits `Promise.all` before every child has finished.
 */
async function run_child(
  entry: readonly [string, AnyStep],
  local: AbortController | undefined,
  input: unknown,
  ctx: RunContext,
): Promise<Settled> {
  const [key, child] = entry
  if (!local) throw new Error('parallel: missing controller')
  const composed = AbortSignal.any([ctx.abort, local.signal])
  const child_ctx: RunContext = { ...ctx, abort: composed }
  try {
    // The entry list erases child types; the public signature guarantees the
    // input satisfies every child, so the erased dispatch re-asserts it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const value = await dispatch_step(child, input as never, child_ctx)
    return { status: 'ok', key, value }
  } catch (err) {
    return { status: 'err', key, err }
  }
}

type ErrorChoice = { readonly thrown: boolean; readonly err: unknown }

/**
 * Choose which settled error (if any) `run_fn` should rethrow: a
 * `suspended_error` wins over any application error so a human-approval gate
 * inside a branch stays resumable rather than masked by a sibling's failure;
 * otherwise the first error in declared order propagates.
 */
function pick_error(settled: ReadonlyArray<Settled>): ErrorChoice {
  let first_err: unknown
  let has_err = false
  let suspended: unknown
  let has_suspended = false
  for (const s of settled) {
    if (s.status !== 'err') continue
    if (!has_err) {
      first_err = s.err
      has_err = true
    }
    if (!has_suspended && s.err instanceof suspended_error) {
      suspended = s.err
      has_suspended = true
    }
  }
  if (has_suspended) return { thrown: true, err: suspended }
  if (has_err) return { thrown: true, err: first_err }
  return { thrown: false, err: undefined }
}

export type ParallelOptions = {
  readonly name?: string
}

/**
 * Build a step that runs named children concurrently on the same input.
 *
 * The step's input type is the intersection of the children's inputs, since
 * every child receives the input verbatim. Returns an object keyed by child
 * name. All children settle before any error propagates; a `suspended_error`
 * wins over application errors so a human-approval gate stays resumable
 * instead of being masked by a sibling's failure.
 */
export function parallel<children extends Record<string, AnyStep>>(
  members: children,
  options?: ParallelOptions,
): Step<ParallelInput<children>, ParallelOutputs<children>> {
  const id = next_id()
  const entries: ReadonlyArray<readonly [string, AnyStep]> = Object.entries(members)
  const child_list: ReadonlyArray<AnyStep> = entries.map(([, s]) => s)
  const keys: ReadonlyArray<string> = entries.map(([k]) => k)

  const run_fn = async (
    input: ParallelInput<children>,
    ctx: RunContext,
  ): Promise<ParallelOutputs<children>> => {
    const controllers = entries.map(() => new AbortController())
    const on_parent_abort = install_abort_fan_out(ctx, controllers)

    try {
      const settled = await Promise.all(
        entries.map((entry, idx) => run_child(entry, controllers[idx], input, ctx)),
      )

      throw_if_aborted(ctx)

      const choice = pick_error(settled)
      if (choice.thrown) throw choice.err

      const out: Record<string, unknown> = {}
      for (const s of settled) {
        if (s.status === 'ok') out[s.key] = s.value
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return out as ParallelOutputs<children>
    } finally {
      ctx.abort.removeEventListener('abort', on_parent_abort)
    }
  }

  const config_meta: Record<string, unknown> = { keys }
  if (options?.name !== undefined) config_meta['display_name'] = options.name

  return {
    id,
    kind: 'parallel',
    children: child_list,
    config: config_meta,
    run: run_fn,
  }
}

register_traced_kind('parallel')
