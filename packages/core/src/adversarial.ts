/**
 * adversarial: build-and-critique loop.
 *
 * `adversarial({ build, critique, accept, max_rounds })` runs up to
 * `max_rounds` iterations of: build a candidate (receiving the prior
 * candidate and critique notes when available) -> critique the candidate
 * -> check `accept(critique_result)`. Returns `{ candidate, converged,
 * rounds }`. Does not throw on non-convergence (spec.md §9 F3).
 *
 * See spec.md §5.10.
 */

import { dispatch_step, register_kind } from './runner.js';
import type { RunContext, Step } from './types.js';

export type AdversarialBuildInput<input, candidate> = {
  readonly input: input;
  readonly prior?: candidate;
  readonly critique?: string;
};

export type AdversarialCritiqueResult = { readonly notes: string } & Record<string, unknown>;

export type AdversarialResult<candidate> = {
  readonly candidate: candidate;
  readonly converged: boolean;
  readonly rounds: number;
};

export type AdversarialConfig<input, candidate> = {
  readonly build: Step<AdversarialBuildInput<input, candidate>, candidate>;
  readonly critique: Step<candidate, AdversarialCritiqueResult>;
  readonly accept: (critique_result: AdversarialCritiqueResult) => boolean;
  readonly max_rounds: number;
};

let adversarial_counter = 0;

function next_id(): string {
  adversarial_counter += 1;
  return `adversarial_${adversarial_counter}`;
}

export function adversarial<input, candidate>(
  config: AdversarialConfig<input, candidate>,
): Step<input, AdversarialResult<candidate>> {
  const id = next_id();
  const { build, critique, accept, max_rounds } = config;
  const rounds_limit = Math.max(1, Math.floor(max_rounds));

  const run_fn = async (
    input: input,
    ctx: RunContext,
  ): Promise<AdversarialResult<candidate>> => {
    let candidate: candidate | undefined = undefined;
    let critique_notes: string | undefined = undefined;
    let round = 0;

    while (round < rounds_limit) {
      round += 1;
      const build_input: AdversarialBuildInput<input, candidate> =
        candidate === undefined
          ? { input }
          : critique_notes === undefined
            ? { input, prior: candidate }
            : { input, prior: candidate, critique: critique_notes };

      candidate = await dispatch_step(build, build_input, ctx);
      const critique_result = await dispatch_step(critique, candidate, ctx);

      if (accept(critique_result)) {
        return { candidate, converged: true, rounds: round };
      }
      critique_notes = critique_result.notes;
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return { candidate: candidate as candidate, converged: false, rounds: round };
  };

  return {
    id,
    kind: 'adversarial',
    children: [build, critique],
    config: { max_rounds: rounds_limit, accept },
    run: run_fn,
  };
}

register_kind('adversarial', async (flow, input, ctx) => {
  const span_id = ctx.trajectory.start_span('adversarial', { id: flow.id });
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
