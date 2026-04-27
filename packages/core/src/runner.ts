/**
 * Runner.
 *
 * Dispatches a step to its kind-specific handler. `runner.ts` contains no
 * composer-specific logic beyond a Map lookup on `step.kind`; each composer
 * file registers its handler at module load via `register_kind(...)`.
 *
 * `run(flow, input, options?)` constructs a fresh `RunContext` per top-level
 * call, installs process signal handlers (opt-out via options), and guarantees
 * cleanup handlers execute in LIFO order on success, failure, or abort.
 *
 * `run.stream(flow, input, options?)` is a secondary entry point returning
 * `{ events, result }`. Streaming is purely observational; the step graph is
 * identical to `run(...)`.
 */

import { randomUUID } from 'node:crypto';
import { create_cleanup_registry } from './cleanup.js';
import { aborted_error } from './errors.js';
import { create_streaming_channel, STREAMING_HIGH_WATER_MARK } from './streaming.js';
import type {
  CheckpointStore,
  RunContext,
  Step,
  TrajectoryEvent,
  TrajectoryLogger,
} from './types.js';

type Dispatcher = (
  flow: Step<unknown, unknown>,
  input: unknown,
  ctx: RunContext,
) => Promise<unknown>;

const dispatch = new Map<string, Dispatcher>();

export function register_kind(kind: string, fn: Dispatcher): void {
  dispatch.set(kind, fn);
}

export type RunOptions = {
  readonly install_signal_handlers?: boolean;
  readonly trajectory?: TrajectoryLogger;
  readonly checkpoint_store?: CheckpointStore;
  readonly resume_data?: Readonly<Record<string, unknown>>;
};

export type StreamingRunHandle<o> = {
  readonly events: AsyncIterable<TrajectoryEvent>;
  readonly result: Promise<o>;
};

const active_runs = new Set<AbortController>();
let signal_handler_installed = false;
let sigint_handler: (() => void) | null = null;
let sigterm_handler: (() => void) | null = null;

function ensure_signal_handlers(): void {
  if (signal_handler_installed) return;
  signal_handler_installed = true;
  const abort_all = (signal_name: string) => () => {
    for (const controller of active_runs) {
      controller.abort(new aborted_error(`received ${signal_name}`, { reason: { signal: signal_name } }));
    }
  };
  sigint_handler = abort_all('SIGINT');
  sigterm_handler = abort_all('SIGTERM');
  process.on('SIGINT', sigint_handler);
  process.on('SIGTERM', sigterm_handler);
}

function release_signal_handlers(): void {
  if (!signal_handler_installed) return;
  if (active_runs.size > 0) return;
  signal_handler_installed = false;
  if (sigint_handler) process.off('SIGINT', sigint_handler);
  if (sigterm_handler) process.off('SIGTERM', sigterm_handler);
  sigint_handler = null;
  sigterm_handler = null;
}

const noop_logger: TrajectoryLogger = {
  record: () => {},
  start_span: (name) => `${name}:${randomUUID().slice(0, 8)}`,
  end_span: () => {},
};

/**
 * Wrap a logger so every emitted event automatically carries `run_id`.
 *
 * Studios and other downstream consumers can multiplex events across runs
 * by reading this field. Callers may still set their own `run_id` on a record;
 * we don't overwrite it.
 */
function stamp_run_id(inner: TrajectoryLogger, run_id: string): TrajectoryLogger {
  return {
    record: (event) => {
      if ('run_id' in event) {
        inner.record(event);
        return;
      }
      inner.record({ ...event, run_id });
    },
    start_span: (name, meta) => {
      if (meta && 'run_id' in meta) return inner.start_span(name, meta);
      return inner.start_span(name, { ...meta, run_id });
    },
    end_span: (id, meta) => {
      if (meta && 'run_id' in meta) {
        inner.end_span(id, meta);
        return;
      }
      inner.end_span(id, { ...meta, run_id });
    },
  };
}

export async function dispatch_step<i, o>(
  flow: Step<i, o>,
  input: i,
  ctx: RunContext,
): Promise<o> {
  const handler = dispatch.get(flow.kind);
  if (!handler) {
    throw new Error(`unknown step kind: ${flow.kind} (step id: ${flow.id})`);
  }
  try {
    const result = await handler(flow, input, ctx);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return result as o;
  } catch (err) {
    prepend_path(err, flow.id);
    throw err;
  }
}

export function prepend_path(err: unknown, id: string): void {
  if (err === null || typeof err !== 'object') return;
  const existing = Reflect.get(err, 'path');
  const next: string[] = Array.isArray(existing)
    ? [id, ...existing.filter((v): v is string => typeof v === 'string')]
    : [id];
  Reflect.set(err, 'path', next);
}

type StartResult<o> = {
  readonly events: AsyncIterable<TrajectoryEvent>;
  readonly result: Promise<o>;
};

function start_run<i, o>(
  flow: Step<i, o>,
  input: i,
  options: RunOptions,
  high_water_mark: number | null,
): StartResult<o> {
  const install_signal_handlers = options.install_signal_handlers !== false;
  const base_logger = options.trajectory ?? noop_logger;
  const streaming = high_water_mark !== null;

  const controller = new AbortController();
  const run_id = randomUUID();

  let logger: TrajectoryLogger = stamp_run_id(base_logger, run_id);
  let stream_events: AsyncIterable<TrajectoryEvent> = empty_async_iterable();
  let close_stream: (() => void) | null = null;

  if (streaming) {
    const channel = create_streaming_channel(logger, high_water_mark);
    logger = channel.logger;
    stream_events = channel.events;
    close_stream = channel.close;
  }

  const cleanup = create_cleanup_registry(logger);

  const ctx: RunContext = {
    run_id,
    trajectory: logger,
    state: new Map(),
    abort: controller.signal,
    emit: (event) => {
      logger.record({ ...event, kind: 'emit' });
    },
    on_cleanup: (fn) => {
      cleanup.register(fn);
    },
    checkpoint_store: options.checkpoint_store,
    resume_data: options.resume_data,
    streaming,
  };

  active_runs.add(controller);
  if (install_signal_handlers) {
    ensure_signal_handlers();
  }

  const result = (async (): Promise<o> => {
    try {
      return await dispatch_step(flow, input, ctx);
    } catch (err) {
      if (controller.signal.aborted && !(err instanceof aborted_error)) {
        const reason = controller.signal.reason;
        if (reason instanceof aborted_error) throw reason;
      }
      throw err;
    } finally {
      try {
        await cleanup.run_all();
      } finally {
        active_runs.delete(controller);
        release_signal_handlers();
        if (close_stream) close_stream();
      }
    }
  })();

  return { events: stream_events, result };
}

function empty_async_iterable(): AsyncIterable<TrajectoryEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<TrajectoryEvent>> =>
          Promise.resolve({ value: undefined, done: true } as IteratorResult<TrajectoryEvent>),
      };
    },
  };
}

async function run_impl<i, o>(
  flow: Step<i, o>,
  input: i,
  options: RunOptions = {},
): Promise<o> {
  const { result } = start_run(flow, input, options, null);
  return result;
}

function run_stream<i, o>(
  flow: Step<i, o>,
  input: i,
  options: RunOptions = {},
): StreamingRunHandle<o> {
  const { events, result } = start_run(flow, input, options, STREAMING_HIGH_WATER_MARK);
  return { events, result };
}

export const run: typeof run_impl & { stream: typeof run_stream } = Object.assign(run_impl, {
  stream: run_stream,
});
