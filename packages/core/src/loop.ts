/**
 * loop: bounded iteration with carry-state.
 *
 * `loop({ init, body, guard?, finish, max_rounds, name? })` runs `body` up to
 * `max_rounds` times, threading `state` through each iteration. After every
 * `body` call, an optional `guard` step inspects (and may transform) the state
 * and decides whether to stop. When `guard.stop` is true, the loop exits
 * "converged"; otherwise it continues until `max_rounds`. `finish` projects
 * the final state to the loop's output value.
 *
 * Non-convergence is data, not error: when `max_rounds` is exhausted without
 * `guard` returning stop, the loop returns `{ value, converged: false, rounds }`.
 * This matches the existing convention from adversarial/consensus.
 *
 * Cancellation: between rounds the parent `ctx.abort` is honored — a pending
 * abort short-circuits and propagates `ctx.abort.reason`. The body and guard
 * receive the parent context unchanged; their own dispatch routes already
 * thread cancellation per the runner contract.
 */

import { aborted_error } from './errors.js';
import { dispatch_step, register_kind, resolve_span_label } from './runner.js';
import type { RunContext, Step } from './types.js';

export type LoopGuardResult<state> = {
  readonly stop: boolean;
  readonly state: state;
};

export type LoopConfig<i, state, o> = {
  readonly name?: string;
  readonly init: (input: i) => state;
  readonly body: Step<state, state>;
  readonly guard?: Step<state, LoopGuardResult<state>>;
  readonly finish: (state: state, round: number) => o;
  readonly max_rounds: number;
};

export type LoopResult<o> = {
  readonly value: o;
  readonly converged: boolean;
  readonly rounds: number;
};

let loop_counter = 0;

function next_id(name: string | undefined): string {
  loop_counter += 1;
  return `${name ?? 'loop'}_${loop_counter}`;
}

function throw_if_aborted(ctx: RunContext): void {
  if (!ctx.abort.aborted) return;
  const reason = ctx.abort.reason;
  throw reason instanceof Error ? reason : new aborted_error('aborted', { reason });
}

export function loop<i, state, o>(
  config: LoopConfig<i, state, o>,
): Step<i, LoopResult<o>> {
  const { init, body, guard, finish, name } = config;
  const rounds_limit = Math.max(1, Math.floor(config.max_rounds));
  const id = next_id(name);

  const run_fn = async (input: i, ctx: RunContext): Promise<LoopResult<o>> => {
    let state = init(input);
    let round = 0;
    let converged = false;

    while (round < rounds_limit) {
      throw_if_aborted(ctx);
      round += 1;
      state = await dispatch_step(body, state, ctx);
      if (guard) {
        throw_if_aborted(ctx);
        const guard_out = await dispatch_step(guard, state, ctx);
        state = guard_out.state;
        if (guard_out.stop) {
          converged = true;
          break;
        }
      }
    }

    const value = finish(state, round);
    return { value, converged, rounds: round };
  };

  const config_meta: Record<string, unknown> = { max_rounds: rounds_limit };
  if (name !== undefined) config_meta['display_name'] = name;
  const children: ReadonlyArray<Step<unknown, unknown>> = guard
    ? [body as Step<unknown, unknown>, guard as Step<unknown, unknown>]
    : [body as Step<unknown, unknown>];

  return {
    id,
    kind: 'loop',
    children,
    config: config_meta,
    run: run_fn,
  };
}

register_kind('loop', async (flow, input, ctx) => {
  const label = resolve_span_label(flow, 'loop');
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
