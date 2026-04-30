import { run } from '@repo/core';
import type { TrajectoryEvent, TrajectoryLogger } from '@repo/core';
import type { Engine, GenerateOptions, GenerateResult } from '@repo/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { reviewer } from '../index.js';
import type { ReviewerOutput } from '../schema.js';

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

type CapturedCall = {
  readonly opts: GenerateOptions<unknown>;
};

function make_mock_engine(canned: unknown): {
  engine: Engine;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const engine: Engine = {
    generate: async <t = string>(opts: GenerateOptions<t>): Promise<GenerateResult<t>> => {
      calls.push({ opts: opts as GenerateOptions<unknown> });
      const parsed = opts.schema ? opts.schema.parse(canned) : canned;
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: parsed as t,
        tool_calls: [],
        steps: [],
        usage: { input_tokens: 1, output_tokens: 1 },
        finish_reason: 'stop',
        model_resolved: { provider: 'mock', model_id: 'rev' },
      };
    },
    register_alias: () => {},
    unregister_alias: () => {},
    resolve_alias: () => ({ provider: 'mock', model_id: 'rev' }),
    list_aliases: () => ({}),
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    dispose: async () => {},
  };
  return { engine, calls };
}

const canned_findings: ReviewerOutput = {
  findings: [
    {
      severity: 'major',
      category: 'correctness',
      message: 'returned value is never read',
    },
    {
      severity: 'minor',
      category: 'style',
      message: 'inconsistent quoting',
      suggestion: 'use single quotes',
    },
  ],
  summary: 'Two findings; one needs attention before merging.',
};

describe('reviewer', () => {
  afterEach(() => {
    for (const l of process.listeners('SIGINT')) process.off('SIGINT', l);
    for (const l of process.listeners('SIGTERM')) process.off('SIGTERM', l);
  });

  it('returns parsed findings and summary from a structured engine result', async () => {
    const { engine } = make_mock_engine(canned_findings);
    const agent = reviewer({ engine });
    const result = await run(
      agent,
      { diff: '+++ a\n--- b\n@@ -1 +1 @@\n-old\n+new' },
      { install_signal_handlers: false },
    );
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.severity).toBe('major');
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it('formats the user prompt with the diff and joins focus areas', async () => {
    const { engine, calls } = make_mock_engine(canned_findings);
    const agent = reviewer({ engine });
    await run(
      agent,
      { diff: '+++ a', focus: ['security', 'tests'] },
      { install_signal_handlers: false },
    );
    expect(calls[0]?.opts.prompt).toBe('Focus areas: security, tests.\n\nDiff:\n\n+++ a');
  });

  it('omits the focus prefix when no focus areas are provided', async () => {
    const { engine, calls } = make_mock_engine(canned_findings);
    const agent = reviewer({ engine });
    await run(agent, { diff: 'D' }, { install_signal_handlers: false });
    expect(calls[0]?.opts.prompt).toBe('Diff:\n\nD');
  });

  it('passes the markdown body as the system prompt', async () => {
    const { engine, calls } = make_mock_engine(canned_findings);
    const agent = reviewer({ engine });
    await run(agent, { diff: 'D' }, { install_signal_handlers: false });
    const system = calls[0]?.opts.system;
    expect(typeof system).toBe('string');
    expect(system).toMatch(/code reviewer/i);
  });

  it('uses "reviewer" as the step name from prompt.md frontmatter', async () => {
    const { engine } = make_mock_engine(canned_findings);
    const agent = reviewer({ engine });
    expect(agent.id).toBe('reviewer');
  });

  it('honors a name override', async () => {
    const { engine } = make_mock_engine(canned_findings);
    const agent = reviewer({ engine, name: 'pr_review' });
    expect(agent.id).toBe('pr_review');
  });

  it('opens a step span carrying the reviewer id and records agent.call', async () => {
    const { engine } = make_mock_engine(canned_findings);
    const agent = reviewer({ engine });
    const { logger, events } = recording_logger();
    await run(agent, { diff: 'D' }, { trajectory: logger, install_signal_handlers: false });

    const span = events.find((e) => e.kind === 'span_start' && e['id'] === 'reviewer');
    expect(span).toBeDefined();
    const call = events.find((e) => e.kind === 'agent.call');
    expect(call).toBeDefined();
    expect(call?.['name']).toBe('reviewer');
  });

  it('surfaces a schema validation error when the engine returns malformed output', async () => {
    const { engine } = make_mock_engine({ findings: 'not-an-array', summary: 1 });
    const agent = reviewer({ engine });
    await expect(
      run(agent, { diff: 'D' }, { install_signal_handlers: false }),
    ).rejects.toThrow();
  });
});
