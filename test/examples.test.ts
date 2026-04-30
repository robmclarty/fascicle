import { describe, expect, it } from 'vitest';
import { run_adversarial_build } from '../examples/adversarial_build.js';
import { run_checkpoint_resume } from '../examples/checkpoint_resume.js';
import { run_ensemble_judge } from '../examples/ensemble_judge.js';
import { run_hello } from '../examples/hello.js';
import { run_learn } from '../examples/learn.js';
import { run_streaming_chat } from '../examples/streaming_chat.js';
import { run_suspend_resume } from '../examples/suspend_resume.js';
import { run_trajectory_logger } from '../examples/trajectory_logger.js';

describe('examples smoke', () => {
  it('hello reverses the input words and preserves the input string', async () => {
    const { input, output } = await run_hello('the quick brown fox');
    expect(input).toBe('the quick brown fox');
    expect(output).toBe('fox brown quick the');
  });

  it('adversarial_build converges on round 1 with deterministic judges', async () => {
    const result = await run_adversarial_build();
    expect(result.converged).toBe(true);
    expect(result.rounds).toBe(1);
    expect(result.candidate).toBe('candidate(brief-text)');
  });

  it('ensemble_judge returns the highest-confidence verdict and all scores', async () => {
    const result = await run_ensemble_judge();
    expect(result.winner.label).toContain('opus');
    expect(result.scores['opus']).toBe(0.92);
    expect(result.scores['sonnet']).toBe(0.81);
    expect(result.scores['gemini']).toBe(0.74);
  });

  it('streaming_chat surfaces emitted tokens and the final result', async () => {
    const { tokens, result } = await run_streaming_chat();
    expect(tokens).toEqual(['hello', ' ...', ' done']);
    expect(result).toBe('hello ... done');
  });

  it('suspend_resume pauses first, resumes second with the supplied decision', async () => {
    const { suspended, resumed } = await run_suspend_resume();
    expect(suspended).toBe(true);
    expect(resumed).toBe('shipped:beta feature');
  });

  it('checkpoint_resume runs the inner step once and serves the second call from cache', async () => {
    const { first, second, call_count } = await run_checkpoint_resume();
    expect(first).toBe('index:abc123');
    expect(second).toBe('index:abc123');
    expect(call_count).toBe(1);
  });

  it('trajectory_logger writes JSONL and fans events out to multiple sinks', async () => {
    const { result, span_names, jsonl_line_count } = await run_trajectory_logger();
    expect(result).toBe(11);
    expect(span_names).toContain('sequence');
    expect(jsonl_line_count).toBeGreaterThan(0);
  });

  it('learn reads a synthetic JSONL trajectory and produces analyzer proposals', async () => {
    const { events_considered, run_ids, proposals } = await run_learn();
    expect(events_considered).toBe(5);
    expect(run_ids).toEqual(['run-a', 'run-b']);
    const targets = proposals.map((p) => p.target).toSorted();
    expect(targets).toEqual(['emit', 'span_end', 'span_start']);
  });
});
