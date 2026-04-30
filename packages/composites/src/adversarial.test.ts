import { run, step } from '@repo/core';
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core';
import { describe, expect, it } from 'vitest';
import { adversarial } from './adversarial.js';

function recording_logger(): { logger: TrajectoryLogger; events: TrajectoryEvent[] } {
  const events: TrajectoryEvent[] = [];
  let id = 0;
  const logger: TrajectoryLogger = {
    record: (event) => {
      events.push(event);
    },
    start_span: (name, meta) => {
      id += 1;
      const span_id = `span_${id}`;
      events.push({ kind: 'span_start', span_id, name, ...meta });
      return span_id;
    },
    end_span: (span_id, meta) => {
      events.push({ kind: 'span_end', span_id, ...meta });
    },
  };
  return { logger, events };
}

describe('adversarial (composite)', () => {
  it('converges when critique accepts on round 2 (spec §10 test 8)', async () => {
    let build_calls = 0;
    const build = step(
      'build',
      (input: { input: { brief: string }; prior?: string; critique?: string }) => {
        build_calls += 1;
        return `${input.input.brief}-v${build_calls}`;
      },
    );
    let critique_calls = 0;
    const critique = step('critique', (_candidate: string) => {
      critique_calls += 1;
      return { notes: `round ${critique_calls}`, verdict: critique_calls >= 2 ? 'pass' : 'nope' };
    });

    const flow = adversarial({
      build,
      critique,
      accept: (r) => r['verdict'] === 'pass',
      max_rounds: 5,
    });

    const result = await run(flow, { brief: 'hello' }, { install_signal_handlers: false });
    expect(result).toEqual({ candidate: 'hello-v2', converged: true, rounds: 2 });
    expect(build_calls).toBe(2);
    expect(critique_calls).toBe(2);
  });

  it('returns non-converged with last candidate when max_rounds reached', async () => {
    const build = step(
      'build',
      (input: { input: number; prior?: string; critique?: string }) =>
        `candidate-${input.input}-${input.prior ?? 'init'}`,
    );
    const critique = step('critique', () => ({ notes: 'no', verdict: 'fail' }));

    const flow = adversarial({
      build,
      critique,
      accept: () => false,
      max_rounds: 2,
    });

    const result = await run(flow, 1, { install_signal_handlers: false });
    expect(result.converged).toBe(false);
    expect(result.rounds).toBe(2);
    expect(result.candidate).toBe('candidate-1-candidate-1-init');
  });

  it('wires {input, prior, critique} correctly on round 2+', async () => {
    const seen: Array<{ prior?: string; critique?: string }> = [];
    const build = step(
      'build',
      (input: { input: string; prior?: string; critique?: string }) => {
        seen.push({
          ...(input.prior === undefined ? {} : { prior: input.prior }),
          ...(input.critique === undefined ? {} : { critique: input.critique }),
        });
        return `c_${seen.length}`;
      },
    );
    let c = 0;
    const critique = step('critique', (candidate: string) => {
      c += 1;
      return { notes: `notes_${c}_${candidate}`, verdict: c >= 3 ? 'pass' : 'nope' };
    });

    const flow = adversarial({
      build,
      critique,
      accept: (r) => r['verdict'] === 'pass',
      max_rounds: 3,
    });

    await run(flow, 'input', { install_signal_handlers: false });
    expect(seen[0]).toEqual({});
    expect(seen[1]).toEqual({ prior: 'c_1', critique: 'notes_1_c_1' });
    expect(seen[2]).toEqual({ prior: 'c_2', critique: 'notes_2_c_2' });
  });

  it('wraps inner execution in an "adversarial" span', async () => {
    const { logger, events } = recording_logger();
    const flow = adversarial({
      build: step('b', () => 'x'),
      critique: step('c', () => ({ notes: 'ok', verdict: 'pass' })),
      accept: () => true,
      max_rounds: 1,
    });

    await run(flow, 'input', { trajectory: logger, install_signal_handlers: false });
    const start = events.find((e) => e.kind === 'span_start' && e['name'] === 'adversarial');
    expect(start).toBeDefined();
    const end = events.find((e) => e.kind === 'span_end' && e['span_id'] === start?.['span_id']);
    expect(end).toBeDefined();
    expect(end?.['error']).toBeUndefined();
  });

  it('honors a user-provided name override', async () => {
    const { logger, events } = recording_logger();
    const flow = adversarial({
      name: 'critic-loop',
      build: step('b', () => 'x'),
      critique: step('c', () => ({ notes: 'ok', verdict: 'pass' })),
      accept: () => true,
      max_rounds: 1,
    });

    await run(flow, 'input', { trajectory: logger, install_signal_handlers: false });
    const labels = events
      .filter((e) => e.kind === 'span_start')
      .map((e) => e['name'] as string);
    expect(labels).toContain('critic-loop');
    expect(labels).not.toContain('adversarial');
  });
});
