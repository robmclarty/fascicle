/**
 * adversarial: build-and-critique loop.
 *
 * `adversarial({ build, critique, accept, max_rounds })` runs up to
 * `max_rounds` iterations of: build a candidate (receiving the prior
 * candidate and critique notes when available) -> critique the candidate
 * -> check `accept(critique_result)`. Returns `{ candidate, converged,
 * rounds }`. Does not throw on non-convergence.
 *
 * Implemented as a `compose`d `loop` whose body builds a new candidate
 * and whose guard runs the critique step and checks `accept`. State is
 * threaded through `scope`/`stash`/`use` so the build and critique steps
 * remain unmodified user-supplied `Step` values.
 *
 * This file is the canonical example of how a user-built composite is
 * structured — the entire implementation is a composition of @repo/core
 * primitives. Read it as documentation.
 */

import { compose, loop, pipe, scope, stash, step, use } from '@repo/core';
import type { Step } from '@repo/core';

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
  readonly name?: string;
  readonly build: Step<AdversarialBuildInput<input, candidate>, candidate>;
  readonly critique: Step<candidate, AdversarialCritiqueResult>;
  readonly accept: (critique_result: AdversarialCritiqueResult) => boolean;
  readonly max_rounds: number;
};

type AdversarialState<input, candidate> = {
  readonly input: input;
  readonly candidate?: candidate;
  readonly critique_notes?: string;
  readonly last_critique?: AdversarialCritiqueResult;
};

function build_input_from_state<i, c>(
  s: AdversarialState<i, c>,
): AdversarialBuildInput<i, c> {
  if (s.candidate === undefined) return { input: s.input };
  if (s.critique_notes === undefined) return { input: s.input, prior: s.candidate };
  return { input: s.input, prior: s.candidate, critique: s.critique_notes };
}

export function adversarial<input, candidate>(
  config: AdversarialConfig<input, candidate>,
): Step<input, AdversarialResult<candidate>> {
  const { build, critique, accept, max_rounds } = config;

  type S = AdversarialState<input, candidate>;

  const body: Step<S, S> = scope([
    stash('state', step('snapshot', (s: S) => s)),
    step('to_build_input', (s: S) => build_input_from_state(s)),
    build,
    use(['state'], (vars, candidate: candidate) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const prior = vars['state'] as S;
      return { ...prior, candidate };
    }),
  ]) as Step<S, S>;

  const guard: Step<S, { stop: boolean; state: S }> = scope([
    stash('state', step('snapshot', (s: S) => s)),
    step('extract_candidate', (s: S) => {
      if (s.candidate === undefined) {
        throw new Error('adversarial: guard reached without a candidate');
      }
      return s.candidate;
    }),
    critique,
    use(['state'], (vars, critique_result: AdversarialCritiqueResult) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const prior = vars['state'] as S;
      return {
        stop: accept(critique_result),
        state: {
          ...prior,
          last_critique: critique_result,
          critique_notes: critique_result.notes,
        },
      };
    }),
  ]) as Step<S, { stop: boolean; state: S }>;

  const inner = pipe(
    loop<input, S, candidate>({
      init: (input) => ({ input }),
      body,
      guard,
      finish: (s) => {
        if (s.candidate === undefined) {
          throw new Error('adversarial: finished without a candidate');
        }
        return s.candidate;
      },
      max_rounds,
    }),
    (result) => ({
      candidate: result.value,
      converged: result.converged,
      rounds: result.rounds,
    }),
  );

  return compose(config.name ?? 'adversarial', inner);
}
