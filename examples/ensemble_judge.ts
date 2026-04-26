/**
 * ensemble_judge: pick the best of N judges.
 *
 * Three stand-in judges score a shared input; the winner is the one with the
 * highest confidence. Matches the canonical "N-of-M pick best" pattern.
 *
 * Deterministic stub `fn` bodies — no engine layer, no network, no LLM calls.
 */

import { ensemble, run, step } from '@repo/fascicle';

type verdict = { readonly label: string; readonly confidence: number };

const opus = step('judge_opus', (brief: string): verdict => ({
  label: `opus-verdict(${brief})`,
  confidence: 0.92,
}));
const sonnet = step('judge_sonnet', (brief: string): verdict => ({
  label: `sonnet-verdict(${brief})`,
  confidence: 0.81,
}));
const gemini = step('judge_gemini', (brief: string): verdict => ({
  label: `gemini-verdict(${brief})`,
  confidence: 0.74,
}));

const flow = ensemble({
  members: { opus, sonnet, gemini },
  score: (r: verdict) => r.confidence,
});

export async function run_ensemble_judge(): Promise<{
  readonly winner: verdict;
  readonly scores: Record<string, number>;
}> {
  return run(flow, 'is this safe to ship?', { install_signal_handlers: false });
}
