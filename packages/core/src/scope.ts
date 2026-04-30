/**
 * scope / stash / use: named state.
 *
 * `scope([...children])` introduces a scope-local `Map<string, unknown>` and
 * runs its children in order, chaining outputs like `sequence`. `stash(key,
 * source)` runs `source`, writes its output to the scope's state at `key`,
 * and passes the value through. `use(keys, fn)` reads the named values from
 * state and runs `fn` with the projection. Inner scopes inherit outer state;
 * writes only affect the inner map.
 *
 * Using `stash` or `use` outside a `scope` is a runtime error with a clear
 * message (spec.md §9 F1).
 *
 * See spec.md §5.16.
 */

import { dispatch_step, register_kind, resolve_span_label } from './runner.js';
import type { RunContext, Step } from './types.js';

type AnyStep = Step<unknown, unknown>;

type LastOutput<children> = children extends readonly [...unknown[], Step<unknown, infer o>]
  ? o
  : children extends readonly [Step<unknown, infer o>]
    ? o
    : unknown;

const scope_states = new WeakSet<ReadonlyMap<string, unknown>>();

function is_scope_state(state: ReadonlyMap<string, unknown>): boolean {
  return scope_states.has(state);
}

let scope_counter = 0;
let stash_counter = 0;
let use_counter = 0;

function next_scope_id(): string {
  scope_counter += 1;
  return `scope_${scope_counter}`;
}

function next_stash_id(): string {
  stash_counter += 1;
  return `stash_${stash_counter}`;
}

function next_use_id(): string {
  use_counter += 1;
  return `use_${use_counter}`;
}

export type ScopeOptions = {
  readonly name?: string;
};

export type StashOptions = {
  readonly name?: string;
};

export type UseOptions = {
  readonly name?: string;
};

export function scope<const children extends readonly AnyStep[]>(
  children: children,
  options?: ScopeOptions,
): Step<unknown, LastOutput<children>> {
  const id = next_scope_id();
  const children_ref = children;

  const run_fn = async (input: unknown, ctx: RunContext): Promise<unknown> => {
    const local = new Map<string, unknown>(ctx.state);
    scope_states.add(local);
    const scope_ctx: RunContext = { ...ctx, state: local };

    let acc: unknown = input;
    for (const child of children_ref) {
      acc = await dispatch_step(child, acc, scope_ctx);
    }
    return acc;
  };

  const config_meta: Record<string, unknown> | undefined =
    options?.name === undefined ? undefined : { display_name: options.name };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    id,
    kind: 'scope',
    children,
    ...(config_meta ? { config: config_meta } : {}),
    run: run_fn,
  } as Step<unknown, LastOutput<children>>;
}

export function stash<i, v>(
  key: string,
  source: Step<i, v>,
  options?: StashOptions,
): Step<i, v> {
  const id = next_stash_id();

  const run_fn = async (input: i, ctx: RunContext): Promise<v> => {
    if (!is_scope_state(ctx.state)) {
      throw new Error('stash() may only appear inside scope(); got: top-level');
    }
    const value = await dispatch_step(source, input, ctx);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    (ctx.state as Map<string, unknown>).set(key, value);
    return value;
  };

  const config_meta: Record<string, unknown> = { key };
  if (options?.name !== undefined) config_meta['display_name'] = options.name;

  return {
    id,
    kind: 'stash',
    children: [source],
    config: config_meta,
    run: run_fn,
  };
}

export function use<const keys extends readonly string[], i, o>(
  keys: keys,
  fn: (
    state: { [k in keys[number]]: unknown },
    input: i,
    ctx: RunContext,
  ) => Promise<o> | o,
  options?: UseOptions,
): Step<i, o> {
  const id = next_use_id();

  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    if (!is_scope_state(ctx.state)) {
      throw new Error('use() may only appear inside scope(); got: top-level');
    }
    const projection: Record<string, unknown> = {};
    for (const k of keys) {
      projection[k] = ctx.state.get(k);
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return fn(projection as { [k in keys[number]]: unknown }, input, ctx);
  };

  const config_meta: Record<string, unknown> = { keys: [...keys] };
  if (options?.name !== undefined) config_meta['display_name'] = options.name;

  return {
    id,
    kind: 'use',
    config: config_meta,
    run: run_fn,
  };
}

register_kind('scope', async (flow, input, ctx) => {
  const label = resolve_span_label(flow, 'scope');
  const span_id = ctx.trajectory.start_span(label, { id: flow.id });
  try {
    const out = await flow.run(input, ctx);
    ctx.trajectory.end_span(span_id, { id: flow.id });
    return out;
  } catch (err) {
    ctx.trajectory.end_span(span_id, {
      id: flow.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
});

register_kind('stash', async (flow, input, ctx) => {
  const label = resolve_span_label(flow, 'stash');
  const span_id = ctx.trajectory.start_span(label, { id: flow.id });
  try {
    const out = await flow.run(input, ctx);
    ctx.trajectory.end_span(span_id, { id: flow.id });
    return out;
  } catch (err) {
    ctx.trajectory.end_span(span_id, {
      id: flow.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
});

register_kind('use', async (flow, input, ctx) => {
  const label = resolve_span_label(flow, 'use');
  const span_id = ctx.trajectory.start_span(label, { id: flow.id });
  try {
    const out = await flow.run(input, ctx);
    ctx.trajectory.end_span(span_id, { id: flow.id });
    return out;
  } catch (err) {
    ctx.trajectory.end_span(span_id, {
      id: flow.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
});
