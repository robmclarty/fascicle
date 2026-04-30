/**
 * learn_reviewer: end-to-end demo combining `reviewer` with `learn`.
 *
 * 1. Run the markdown-defined `reviewer` agent on three hand-crafted diffs,
 *    writing each run's trajectory to its own JSONL file via
 *    `filesystem_logger`.
 * 2. Run the `learn` composer over the directory of trajectories with a
 *    pure-TypeScript analyzer that aggregates `agent.call` token usage and
 *    proposes prompt-tightening improvements.
 *
 * The engine is a stub returning canned, schema-conforming findings — the
 * demo proves the wiring without any API keys. Swap `make_stub_engine` for
 * `create_engine({...})` to drive the same flow against a real provider.
 *
 * Run directly:
 *   pnpm exec tsx examples/learn_reviewer.ts
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reviewer, type ReviewerInput, type ReviewerOutput } from '@repo/agents';
import {
  learn,
  run,
  step,
  type Engine,
  type GenerateOptions,
  type GenerateResult,
  type Improvement,
  type LearnInput,
} from '@repo/fascicle';
import { filesystem_logger } from '@repo/observability';

function make_stub_engine(canned: ReviewerOutput): Engine {
  return {
    generate: async <t = string>(
      opts: GenerateOptions<t>,
    ): Promise<GenerateResult<t>> => {
      const parsed = opts.schema ? opts.schema.parse(canned) : canned;
      return {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        content: parsed as t,
        tool_calls: [],
        steps: [],
        usage: { input_tokens: 250, output_tokens: 90 },
        finish_reason: 'stop',
        model_resolved: { provider: 'stub', model_id: 'reviewer-canned' },
      };
    },
    register_alias: () => {},
    unregister_alias: () => {},
    resolve_alias: () => ({ provider: 'stub', model_id: 'reviewer-canned' }),
    list_aliases: () => ({}),
    register_price: () => {},
    resolve_price: () => undefined,
    list_prices: () => ({}),
    dispose: async () => {},
  };
}

const CANNED_FINDINGS: ReviewerOutput = {
  findings: [
    {
      severity: 'minor',
      category: 'style',
      message: 'inconsistent quoting in the changed lines',
    },
  ],
  summary: 'One stylistic nit; safe to merge.',
};

const DIFFS: ReadonlyArray<ReviewerInput> = [
  {
    diff: '--- a/x.ts\n+++ b/x.ts\n@@\n-const a = "x"\n+const a = \'x\'\n',
    focus: ['style'],
  },
  {
    diff: '--- a/y.ts\n+++ b/y.ts\n@@\n-const b = `y`\n+const b = \'y\'\n',
    focus: ['style'],
  },
  {
    diff: '--- a/z.ts\n+++ b/z.ts\n@@\n-const c = "z"\n+const c = \'z\'\n',
    focus: ['style', 'tests'],
  },
];

type AgentUsage = {
  readonly calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
};

function aggregate_agent_usage(events: LearnInput['events']): Map<string, AgentUsage> {
  const out = new Map<string, { calls: number; input_tokens: number; output_tokens: number }>();
  for (const event of events) {
    if (event.kind !== 'agent.call') continue;
    const name = typeof event['name'] === 'string' ? event['name'] : 'unknown';
    const usage = event['usage'];
    const input_tokens =
      usage && typeof usage === 'object' && 'input_tokens' in usage
        ? Number((usage as { input_tokens: unknown }).input_tokens) || 0
        : 0;
    const output_tokens =
      usage && typeof usage === 'object' && 'output_tokens' in usage
        ? Number((usage as { output_tokens: unknown }).output_tokens) || 0
        : 0;
    const acc = out.get(name) ?? { calls: 0, input_tokens: 0, output_tokens: 0 };
    acc.calls += 1;
    acc.input_tokens += input_tokens;
    acc.output_tokens += output_tokens;
    out.set(name, acc);
  }
  return out;
}

type AnalyzerOutput = {
  readonly proposals: ReadonlyArray<Improvement>;
  readonly per_agent: Readonly<Record<string, AgentUsage>>;
};

const analyzer = step('reviewer_usage_analyzer', (input: LearnInput): AnalyzerOutput => {
  const agents = aggregate_agent_usage(input.events);
  const per_agent: Record<string, AgentUsage> = {};
  const proposals: Improvement[] = [];
  for (const [name, agg] of agents.entries()) {
    per_agent[name] = agg;
    const avg_in = agg.calls > 0 ? Math.round(agg.input_tokens / agg.calls) : 0;
    const avg_out = agg.calls > 0 ? Math.round(agg.output_tokens / agg.calls) : 0;
    proposals.push({
      target: name,
      kind: 'prompt',
      rationale: `${String(agg.calls)} calls; avg ${String(avg_in)} in / ${String(avg_out)} out tokens. Compare against a leaner baseline before raising or lowering the model tier.`,
      suggestion:
        'Tighten the system prompt to remove redundant instructions, then re-measure across the same diffs to confirm the move was net-positive.',
    });
  }
  return { proposals, per_agent };
});

export async function run_learn_reviewer(): Promise<{
  readonly events_considered: number;
  readonly run_ids: ReadonlyArray<string>;
  readonly proposals: ReadonlyArray<Improvement>;
  readonly per_agent: Readonly<Record<string, AgentUsage>>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'fascicle-learn-reviewer-'));
  const engine = make_stub_engine(CANNED_FINDINGS);
  try {
    const reviewer_step = reviewer({ engine });

    for (let i = 0; i < DIFFS.length; i += 1) {
      const trajectory_path = join(dir, `run_${String(i).padStart(2, '0')}.jsonl`);
      const sink = filesystem_logger({ output_path: trajectory_path });
      const input = DIFFS[i];
      if (input === undefined) continue;
      // oxlint-disable-next-line no-await-in-loop
      await run(reviewer_step, input, {
        trajectory: sink,
        install_signal_handlers: false,
      });
    }

    const learn_flow = learn({
      flow: reviewer_step,
      source: { kind: 'dir', dir },
      analyzer,
    });

    const result = await run(learn_flow, undefined, { install_signal_handlers: false });

    return {
      events_considered: result.events_considered,
      run_ids: result.run_ids,
      proposals: result.proposals.proposals,
      per_agent: result.proposals.per_agent,
    };
  } finally {
    await engine.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_learn_reviewer()
    .then(({ events_considered, run_ids, proposals, per_agent }) => {
      console.log(`events considered: ${String(events_considered)}`);
      console.log(`run ids:           ${run_ids.join(', ')}\n`);
      console.log('per-agent usage:');
      for (const [name, agg] of Object.entries(per_agent)) {
        console.log(
          `  ${name}: ${String(agg.calls)} calls, ${String(agg.input_tokens)} in, ${String(agg.output_tokens)} out`,
        );
      }
      console.log('\nproposals:');
      for (const p of proposals) {
        console.log(`  - [${p.kind}] ${p.target}`);
        console.log(`      rationale:  ${p.rationale}`);
        console.log(`      suggestion: ${p.suggestion}`);
      }
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
