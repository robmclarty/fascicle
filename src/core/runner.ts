/**
 * Runner.
 *
 * Dispatches a step to its kind-specific handler. `runner.ts` contains no
 * composer-specific logic beyond a Map lookup on `step.kind`; each composer
 * file registers its handler at module load via `register_kind(...)`.
 *
 * `run(flow, input, options?)` constructs a fresh `RunContext` per top-level
 * call, installs process signal handlers (opt-out via options), forwards an
 * optional caller-supplied `AbortSignal` into the run, and guarantees cleanup
 * handlers execute in LIFO order on success, failure, or abort.
 *
 * `run.stream(flow, input, options?)` is a secondary entry point returning
 * `{ events, result }`. Streaming is purely observational; the step graph is
 * identical to `run(...)`.
 */

import { randomUUID } from 'node:crypto'
import { create_cleanup_registry } from './cleanup.js'
import { aborted_error, suspended_error } from './errors.js'
import { create_streaming_channel, STREAMING_HIGH_WATER_MARK } from './streaming.js'
import type {
  CheckpointStore,
  RunContext,
  Step,
  TrajectoryEvent,
  TrajectoryLogger,
} from './types.js'

type Dispatcher = (
  flow: Step<unknown, unknown>,
  input: unknown,
  ctx: RunContext,
) => Promise<unknown>

const dispatch = new Map<string, Dispatcher>()

/**
 * Register the dispatch handler for a step kind.
 *
 * Composer files call this via `register_traced_kind` at module load, which is
 * how the runner stays free of composer-specific logic.
 */
function register_kind(kind: string, fn: Dispatcher): void {
  dispatch.set(kind, fn)
}

/**
 * Resolve the trajectory span label for a step. Prefers a non-empty
 * `display_name` from `flow.config`; otherwise falls back to the supplied
 * default (typically the step's `kind`).
 *
 * Dispatch handlers use this so that any composer carrying a user-supplied
 * `name` surfaces under that label in the trajectory, while unconfigured
 * composers retain their kind-based label.
 */
function resolve_span_label(
  flow: Step<unknown, unknown>,
  fallback: string,
): string {
  const display = flow.config?.['display_name']
  return typeof display === 'string' && display.length > 0 ? display : fallback
}

/**
 * Register the standard span-wrapping dispatch handler for a composer kind.
 *
 * Every composer wraps `flow.run` in a span identically; this centralizes that
 * boilerplate and threads span parentage: the span opens with the current
 * `ctx.parent_span_id` as its parent, and `flow.run` receives a child context
 * whose `parent_span_id` is this span. Children dispatched from within
 * (including concurrent ones under `parallel`/`map`, which spread the context)
 * therefore nest correctly instead of leaving `parent_span_id` unpopulated.
 */
export function register_traced_kind(kind: string): void {
  register_kind(kind, async (flow, input, ctx) => {
    const label = resolve_span_label(flow, kind)
    const span_meta: Record<string, unknown> = { id: flow.id }
    if (ctx.parent_span_id !== undefined) {
      span_meta['parent_span_id'] = ctx.parent_span_id
    }
    const span_id = ctx.trajectory.start_span(label, span_meta)
    const child_ctx: RunContext = { ...ctx, parent_span_id: span_id }
    try {
      const out = await flow.run(input, child_ctx)
      ctx.trajectory.end_span(span_id, { id: flow.id })
      return out
    } catch (err) {
      ctx.trajectory.end_span(span_id, {
        id: flow.id,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  })
}

type RunOptions = {
  readonly install_signal_handlers?: boolean
  readonly trajectory?: TrajectoryLogger
  readonly checkpoint_store?: CheckpointStore
  readonly resume_data?: Readonly<Record<string, unknown>>
  // A caller-owned cancellation source (HTTP request, queue shutdown, MCP
  // request, AbortSignal.timeout). When it fires the run aborts with its
  // reason, composing with the internal controller and the process signal
  // handlers rather than replacing them.
  readonly abort?: AbortSignal
}

type StreamingRunHandle<o> = {
  readonly events: AsyncIterable<TrajectoryEvent>
  readonly result: Promise<o>
}

const active_runs = new Set<AbortController>()
let signal_handler_installed = false
let sigint_handler: (() => void) | null = null
let sigterm_handler: (() => void) | null = null

/**
 * Install process-wide SIGINT/SIGTERM handlers once.
 *
 * The handlers abort every active run with an `aborted_error` naming the
 * signal, so a Ctrl-C tears down all in-flight flows through the normal
 * abort/cleanup path instead of killing the process mid-step.
 */
function ensure_signal_handlers(): void {
  if (signal_handler_installed) return
  signal_handler_installed = true
  const abort_all = (signal_name: string) => () => {
    for (const controller of active_runs) {
      controller.abort(new aborted_error(`received ${signal_name}`, { reason: { signal: signal_name } }))
    }
  }
  sigint_handler = abort_all('SIGINT')
  sigterm_handler = abort_all('SIGTERM')
  process.on('SIGINT', sigint_handler)
  process.on('SIGTERM', sigterm_handler)
}

/**
 * Remove the process signal handlers once the last active run settles.
 *
 * Keeps a library embed from leaving stray `process.on` listeners behind
 * after all runs complete.
 */
function release_signal_handlers(): void {
  if (!signal_handler_installed) return
  if (active_runs.size > 0) return
  signal_handler_installed = false
  if (sigint_handler) process.off('SIGINT', sigint_handler)
  if (sigterm_handler) process.off('SIGTERM', sigterm_handler)
  sigint_handler = null
  sigterm_handler = null
}

const noop_logger: TrajectoryLogger = {
  record: () => {},
  start_span: (name) => `${name}:${randomUUID().slice(0, 8)}`,
  end_span: () => {},
}

/**
 * Wrap a logger so every emitted event automatically carries `run_id` and a
 * `ts` (epoch milliseconds) stamped at emission.
 *
 * Studios and other downstream consumers multiplex events across runs by
 * `run_id` and reconstruct real timing from `ts` instead of fabricating it at
 * ingest. Either field already present on an event or its meta is preserved;
 * we never overwrite a caller-supplied value.
 */
function decorate_logger(inner: TrajectoryLogger, run_id: string): TrajectoryLogger {
  const stamp_meta = (
    meta: Record<string, unknown> | undefined,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...meta }
    if (!('run_id' in out)) out['run_id'] = run_id
    if (!('ts' in out)) out['ts'] = Date.now()
    return out
  }
  return {
    record: (event) => {
      if ('run_id' in event && 'ts' in event) {
        inner.record(event)
        return
      }
      const extra: Record<string, unknown> = {}
      if (!('run_id' in event)) extra['run_id'] = run_id
      if (!('ts' in event)) extra['ts'] = Date.now()
      inner.record({ ...event, ...extra })
    },
    start_span: (name, meta) => inner.start_span(name, stamp_meta(meta)),
    end_span: (id, meta) => {
      inner.end_span(id, stamp_meta(meta))
    },
  }
}

/**
 * Route a step to its registered kind handler.
 *
 * This is the single entry point composers use to run children. On failure
 * the step's id is prepended to the error's `path`, so an error surfacing
 * from a deep tree carries the chain of step ids it crossed.
 */
export async function dispatch_step<i, o>(
  flow: Step<i, o>,
  input: i,
  ctx: RunContext,
): Promise<o> {
  const handler = dispatch.get(flow.kind)
  if (!handler) {
    throw new Error(`unknown step kind: ${flow.kind} (step id: ${flow.id})`)
  }
  try {
    const result = await handler(flow, input, ctx)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return result as o
  } catch (err) {
    prepend_path(err, flow.id)
    throw err
  }
}

/**
 * Prepend a step id to the `path` array carried on an error object.
 *
 * Mutates the error in place so the path accumulates as the error bubbles up
 * through nested dispatches. Non-object errors are left untouched.
 */
function prepend_path(err: unknown, id: string): void {
  if (err === null || typeof err !== 'object') return
  const existing = Reflect.get(err, 'path')
  const next: string[] = Array.isArray(existing)
    ? [id, ...existing.filter((v): v is string => typeof v === 'string')]
    : [id]
  Reflect.set(err, 'path', next)
}

/**
 * Throw the abort reason if the context has been cancelled. Composers that
 * iterate over children (`sequence`, `scope`, `loop`) call this between steps
 * so a pending abort is honored before the next child starts, not only when a
 * downstream dispatch happens to observe it.
 */
export function throw_if_aborted(ctx: RunContext): void {
  if (!ctx.abort.aborted) return
  const reason = ctx.abort.reason
  throw reason instanceof Error ? reason : new aborted_error('aborted', { reason })
}

/**
 * Install a fan-out abort listener over a set of child controllers: when
 * `ctx.abort` fires, every controller currently in `controllers` is aborted
 * with the same reason. An already-aborted parent fires immediately instead
 * of registering a listener.
 *
 * Concurrent composers (`map`, `parallel`) use this to propagate a parent
 * abort into each in-flight child's composed signal. `controllers` is read by
 * reference, so a caller that appends to the array after installing (as
 * `map` does per newly-started item) is still covered by later aborts.
 * Returns the listener so the caller can remove it once its children settle.
 */
export function install_abort_fan_out(
  ctx: RunContext,
  controllers: ReadonlyArray<AbortController>,
): () => void {
  const on_parent_abort = (): void => {
    for (const c of controllers) c.abort(ctx.abort.reason)
  }
  if (ctx.abort.aborted) {
    on_parent_abort()
  } else {
    ctx.abort.addEventListener('abort', on_parent_abort, { once: true })
  }
  return on_parent_abort
}

/**
 * Forward a caller-owned AbortSignal into the run's internal controller and
 * return an unlink function. The reason is preserved so the original
 * cancellation cause propagates out of `run`. The listener is `once` and the
 * returned unlink is called when the run settles, so a long-lived host (an MCP
 * server, an HTTP worker) firing many short runs against one external signal
 * does not accumulate listeners.
 */
function link_external_abort(
  controller: AbortController,
  external: AbortSignal | undefined,
): () => void {
  if (external === undefined) return () => {}
  if (external.aborted) {
    controller.abort(external.reason)
    return () => {}
  }
  const on_abort = (): void => {
    controller.abort(external.reason)
  }
  external.addEventListener('abort', on_abort, { once: true })
  return () => {
    external.removeEventListener('abort', on_abort)
  }
}

type StartResult<o> = {
  readonly events: AsyncIterable<TrajectoryEvent>
  readonly result: Promise<o>
}

/**
 * Construct a run context and execute a flow to settlement.
 *
 * Shared engine behind `run` and `run.stream`; `high_water_mark` selects the
 * mode (null means no streaming channel). Owns the full run lifecycle:
 * abort wiring, logger decoration, cleanup registration, signal handlers,
 * and the settle-time teardown ordering (cleanup handlers first, then
 * unlinking and stream close).
 */
function start_run<i, o>(
  flow: Step<i, o>,
  input: i,
  options: RunOptions,
  high_water_mark: number | null,
): StartResult<o> {
  const install_signal_handlers = options.install_signal_handlers !== false
  const base_logger = options.trajectory ?? noop_logger
  const streaming = high_water_mark !== null

  const controller = new AbortController()
  const unlink_abort = link_external_abort(controller, options.abort)
  const run_id = randomUUID()

  let stream_events: AsyncIterable<TrajectoryEvent> = empty_async_iterable()
  let close_stream: (() => void) | null = null
  let inner: TrajectoryLogger = base_logger

  if (streaming) {
    // Decorate must wrap the streaming channel, not the reverse: the channel
    // enqueues a copy of each event for `run.stream` consumers, so it has to
    // see the events after `decorate_logger` has stamped `ts` and `run_id`.
    const channel = create_streaming_channel(base_logger, high_water_mark)
    inner = channel.logger
    stream_events = channel.events
    close_stream = channel.close
  }

  const logger: TrajectoryLogger = decorate_logger(inner, run_id)

  const cleanup = create_cleanup_registry(logger)

  const ctx: RunContext = {
    run_id,
    trajectory: logger,
    state: new Map(),
    abort: controller.signal,
    emit: (event) => {
      logger.record({ ...event, kind: 'emit' })
    },
    on_cleanup: (fn) => {
      cleanup.register(fn)
    },
    call<ci, co>(this: RunContext, s: Step<ci, co>, child_input: ci): Promise<co> {
      throw_if_aborted(this)
      return dispatch_step(s, child_input, this)
    },
    checkpoint_store: options.checkpoint_store,
    resume_data: options.resume_data,
    streaming,
  }

  active_runs.add(controller)
  if (install_signal_handlers) {
    ensure_signal_handlers()
  }

  const result = (async (): Promise<o> => {
    try {
      // Honor an external signal that was already aborted at call time, so the
      // run rejects without dispatching even when the flow is a single leaf
      // step that never reaches a cooperative abort check.
      throw_if_aborted(ctx)
      return await dispatch_step(flow, input, ctx)
    } catch (err) {
      if (controller.signal.aborted && !(err instanceof aborted_error)) {
        const reason = controller.signal.reason
        if (reason instanceof aborted_error) throw reason
      }
      throw err
    } finally {
      try {
        await cleanup.run_all()
      } finally {
        unlink_abort()
        active_runs.delete(controller)
        release_signal_handlers()
        if (close_stream) close_stream()
      }
    }
  })()

  return { events: stream_events, result }
}

/**
 * Build an async iterable that is immediately done.
 *
 * Non-streaming runs hand this to callers so the `events` field always has
 * the same shape regardless of mode.
 */
function empty_async_iterable(): AsyncIterable<TrajectoryEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<TrajectoryEvent>> =>
          Promise.resolve({ value: undefined, done: true } as IteratorResult<TrajectoryEvent>),
      }
    },
  }
}

/**
 * Execute a flow and resolve with its final output.
 */
async function run_impl<i, o>(
  flow: Step<i, o>,
  input: i,
  options: RunOptions = {},
): Promise<o> {
  const { result } = start_run(flow, input, options, null)
  return result
}

/**
 * Execute a flow while exposing its trajectory events as an async iterable.
 */
function run_stream<i, o>(
  flow: Step<i, o>,
  input: i,
  options: RunOptions = {},
): StreamingRunHandle<o> {
  const { events, result } = start_run(flow, input, options, STREAMING_HIGH_WATER_MARK)
  return { events, result }
}

export type RunOutcome<o> =
  | { readonly kind: 'done'; readonly output: o }
  | {
      readonly kind: 'suspended'
      readonly id: string
      readonly resume: (data: unknown) => Promise<RunOutcome<o>>
    }

/**
 * Execute a flow, reporting suspension as a typed outcome instead of a
 * thrown `suspended_error`.
 *
 * Resolves `{ kind: 'done', output }` on completion. When a `suspend` gate
 * fires, resolves `{ kind: 'suspended', id, resume }` where `id` is the
 * gate's suspend id and `resume(data)` re-runs the flow from the original
 * input with `resume_data[id] = data` merged over the caller's options: the
 * same full re-run semantics as calling `run` again yourself, so pure
 * prefixes replay and `checkpoint`ed steps are served from the store. The
 * returned promise resolves to the next outcome, so a flow with several
 * gates is driven by awaiting `resume` repeatedly. Real errors still throw,
 * from the initial call and from `resume` alike.
 */
async function run_until_suspended<i, o>(
  flow: Step<i, o>,
  input: i,
  options: RunOptions = {},
): Promise<RunOutcome<o>> {
  try {
    return { kind: 'done', output: await run_impl(flow, input, options) }
  } catch (err) {
    if (!(err instanceof suspended_error)) throw err
    const id = err.suspend_id
    return {
      kind: 'suspended',
      id,
      resume: (data) =>
        run_until_suspended(flow, input, {
          ...options,
          resume_data: { ...options.resume_data, [id]: data },
        }),
    }
  }
}

/**
 * The public entry point for executing a flow.
 *
 * Callable as `run(flow, input, options?)` for a plain result,
 * `run.stream(flow, input, options?)` for `{ events, result }`, or
 * `run.until_suspended(flow, input, options?)` for a `RunOutcome` that
 * carries suspension as data. All share one implementation, so every entry
 * point runs the same graph identically.
 */
export const run: typeof run_impl & {
  stream: typeof run_stream
  until_suspended: typeof run_until_suspended
} = Object.assign(run_impl, {
  stream: run_stream,
  until_suspended: run_until_suspended,
})
