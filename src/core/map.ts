/**
 * map: per-item execution.
 *
 * `map({ items, do, concurrency? })` extracts an array via `items(input)`,
 * runs `do` once per element, returns an array in the same order as inputs.
 * `concurrency` caps simultaneous in-flight items; omitted means full
 * parallelism.
 *
 * The first item that throws stops new items from starting, and its error
 * propagates once the in-flight items settle, so every result the other items
 * computed is lost. `settle: true` keeps them, the way a batch needs: every
 * item runs, and its slot in the output holds `{ ok: true, value }` or
 * `{ ok: false, error }`. The error is reduced to the fields that survive JSON
 * (`message`, `name`, `kind`, `path`), so a settled array can be checkpointed
 * and reads the same when a resumed run takes it from the store. Each failed
 * item also records a `map_item_failed` event. `suspended_error` and
 * `aborted_error` are control flow rather than failures, so they propagate in
 * both modes, and so does an error that `items` itself throws.
 *
 * Cancellation: each in-flight item runs with a composed abort signal via
 * `AbortSignal.any([ctx.abort, child_local])`.
 * On abort no new items start. The composer awaits all in-flight items before
 * rethrowing `ctx.abort.reason`.
 */

import { description_meta } from './display_name.js'
import { error_path, is_control_flow_error } from './errors.js'
import { dispatch_step, install_abort_fan_out, register_traced_kind, throw_if_aborted } from './runner.js'
import type { RunContext, Step } from './types.js'

export type MapConfig<input, item, result> = {
  readonly name?: string
  readonly description?: string
  readonly items: (input: input) => ReadonlyArray<item> | Promise<ReadonlyArray<item>>
  readonly do: Step<item, result>
  readonly concurrency?: number
  /**
   * Unset or `false`: the first item that throws fails the map. A map that
   * keeps every item's outcome takes a `MapSettleConfig` instead.
   */
  readonly settle?: false
}

/**
 * The config of a map that settles: every item runs, and the output holds one
 * `Settled` entry per item, in input order.
 */
export type MapSettleConfig<input, item, result> = Omit<MapConfig<input, item, result>, 'settle'> & {
  readonly settle: true
}

/**
 * What a settled item keeps of the error it threw: the `message`, plus the
 * `name`, `kind`, and step-id `path` when the error has them. All of it is
 * plain data, so it survives a checkpoint, and `kind` (`timeout_error`, for
 * example) is how to tell one failure from another once the class is gone.
 */
export type SettledError = {
  readonly message: string
  readonly name?: string
  readonly kind?: string
  readonly path?: ReadonlyArray<string>
}

/**
 * One item's outcome in the output of a map that settles.
 */
export type Settled<o> =
  | { readonly ok: true; readonly value: o }
  | { readonly ok: false; readonly error: SettledError }

let map_counter = 0

/**
 * Generate a unique step id of the form `map_<n>`.
 */
function next_id(): string {
  map_counter += 1
  return `map_${map_counter}`
}

/**
 * Reduce a thrown value to the fields of it that survive JSON. A value that
 * isn't an `Error` keeps only its string form, as the message.
 */
function settled_error(err: unknown): SettledError {
  if (!(err instanceof Error)) return { message: String(err) }
  const kind: unknown = Reflect.get(err, 'kind')
  const path = error_path(err)
  return {
    message: err.message,
    ...(err.name.length > 0 ? { name: err.name } : {}),
    ...(typeof kind === 'string' ? { kind } : {}),
    ...(path === undefined ? {} : { path }),
  }
}

/**
 * Turn an item's error into its slot in a settled map's output, and record
 * the failure as a `map_item_failed` event, with the error's `kind` as
 * `error_kind` when it has one.
 */
function settle_failure(err: unknown, index: number, step_id: string, ctx: RunContext): Settled<never> {
  const error = settled_error(err)
  ctx.trajectory.record({
    kind: 'map_item_failed',
    step_id,
    index,
    error: error.message,
    ...(error.kind === undefined ? {} : { error_kind: error.kind }),
  })
  return { ok: false, error }
}

/**
 * Build a map step that fills each item's slot with `fulfilled(value)`.
 * Given `rejected`, an item's application error fills its slot as well, and
 * without it the first error fails the map.
 */
function build_map<input, item, result, slot>(
  config: MapConfig<input, item, result> | MapSettleConfig<input, item, result>,
  fulfilled: (value: result) => slot,
  rejected?: (err: unknown, index: number, step_id: string, ctx: RunContext) => slot,
): Step<input, slot[]> {
  const id = next_id()
  const { items, do: per_item, concurrency, name } = config

  const run_fn = async (input: input, ctx: RunContext): Promise<slot[]> => {
    const list = await items(input)
    if (list.length === 0) return []
    const results: slot[] = Array.from({ length: list.length })

    const limit = concurrency === undefined ? list.length : Math.max(1, concurrency)
    const controllers: AbortController[] = []
    const on_parent_abort = install_abort_fan_out(ctx, controllers)

    let cursor = 0
    let worker_error: unknown = undefined

    // Run one item into its slot. An error that stops the map is kept, the
    // first one only, for the throw that follows once in-flight items settle.
    const run_one = async (idx: number): Promise<void> => {
      const local = new AbortController()
      controllers.push(local)
      const composed = AbortSignal.any([ctx.abort, local.signal])
      const child_ctx: RunContext = { ...ctx, abort: composed }
      const item_value = list[idx]
      try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const value = await dispatch_step(per_item, item_value as item, child_ctx)
        results[idx] = fulfilled(value)
      } catch (err) {
        // Control flow stops the map in either mode, and so does anything
        // thrown once the map is being aborted, since the map is going to
        // throw the abort and the item failed because of it.
        if (rejected !== undefined && !is_control_flow_error(err) && !ctx.abort.aborted) {
          results[idx] = rejected(err, idx, id, ctx)
        } else if (worker_error === undefined) {
          worker_error = err
        }
      }
    }

    const worker = async (): Promise<void> => {
      while (true) {
        if (ctx.abort.aborted || worker_error !== undefined) return
        const idx = cursor
        cursor += 1
        if (idx >= list.length) return
        await run_one(idx)
      }
    }

    try {
      const worker_count = Math.min(limit, list.length)
      const workers: Promise<void>[] = []
      for (let w = 0; w < worker_count; w += 1) {
        workers.push(worker())
      }
      await Promise.all(workers)

      throw_if_aborted(ctx)
      if (worker_error !== undefined) throw worker_error

      return results
    } finally {
      ctx.abort.removeEventListener('abort', on_parent_abort)
    }
  }

  const config_meta: Record<string, unknown> = { items }
  if (concurrency !== undefined) config_meta['concurrency'] = concurrency
  if (rejected !== undefined) config_meta['settle'] = true
  if (name !== undefined) config_meta['display_name'] = name

  return {
    id,
    kind: 'map',
    children: [per_item],
    config: config_meta,
    ...description_meta(config.description),
    run: run_fn,
  }
}

/**
 * Build a per-item execution step.
 *
 * Extracts an array via `items(input)`, runs `do` once per element through a
 * bounded worker pool, and returns results in input order. The first item
 * failure stops new work and propagates after in-flight items settle. With
 * `settle: true` every item runs, and the output holds each one's `Settled`
 * outcome instead.
 */
export function map<input, item, result>(
  config: MapSettleConfig<input, item, result>,
): Step<input, Settled<result>[]>
export function map<input, item, result>(config: MapConfig<input, item, result>): Step<input, result[]>
export function map<input, item, result>(
  config: MapConfig<input, item, result> | MapSettleConfig<input, item, result>,
): Step<input, result[]> | Step<input, Settled<result>[]> {
  if (config.settle === true) {
    return build_map(config, (value): Settled<result> => ({ ok: true, value }), settle_failure)
  }
  return build_map(config, (value: result) => value)
}

register_traced_kind('map')
