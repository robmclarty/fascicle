/**
 * adversarial_build: build-and-critique pattern with ensemble judging.
 *
 * Shows the canonical "candidate produced, critique judges, loop until
 * accepted" pattern, with the critique powered by an ensemble of judges
 * that each score the candidate and the best-scoring verdict wins.
 *
 * Deterministic stub `fn` bodies — no engine layer, no network, no LLM calls.
 */

import { adversarial, ensemble, pipe, run, step } from '@repo/fascicle';

type build_in = { readonly input: string; readonly prior?: string; readonly critique?: string };
type critique_out = { readonly verdict: 'pass' | 'fail'; readonly notes: string; readonly confidence: number };

const build_fn = step('build', (i: build_in) => `candidate(${i.input})`);

const judge = (id: string, verdict: 'pass' | 'fail', confidence: number) =>
  step(id, (_candidate: string): critique_out => ({ verdict, notes: `${id}-notes`, confidence }));

const jury = ensemble({
  members: {
    opus: judge('judge_opus', 'pass', 0.9),
    sonnet: judge('judge_sonnet', 'pass', 0.8),
    haiku: judge('judge_haiku', 'pass', 0.6),
  },
  score: (r: critique_out) => r.confidence,
});

const flow = adversarial<string, string>({
  build: build_fn,
  critique: pipe(jury, (r: { winner: critique_out }) => r.winner),
  accept: (c) => c['verdict'] === 'pass',
  max_rounds: 3,
});

export async function run_adversarial_build(): Promise<{
  readonly candidate: string;
  readonly converged: boolean;
  readonly rounds: number;
}> {
  return run(flow, 'brief-text', { install_signal_handlers: false });
}
