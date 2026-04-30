/**
 * learn: offline self-improvement over a recorded trajectory.
 *
 * Synthesizes a tiny JSONL trajectory file in a tempdir, then runs `learn`
 * with a trivial analyzer that tallies events by kind and emits one
 * "improvement" proposal per kind. No engine layer, no network, no LLM
 * calls — the analyzer is pure TypeScript.
 *
 * Run directly:
 *   pnpm exec tsx examples/learn.ts
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  learn,
  run,
  step,
  type Improvement,
  type LearnInput,
  type TrajectoryEvent,
} from '@repo/fascicle';

const studied_flow = step('greet', (name: string): string => `hello, ${name}`);

const tally_analyzer = step(
  'tally',
  (input: LearnInput): ReadonlyArray<Improvement> => {
    const counts = new Map<string, number>();
    for (const event of input.events) {
      counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
    }
    return [...counts.entries()].map(
      ([kind, count]): Improvement => ({
        target: kind,
        kind: 'note',
        rationale: `observed ${String(count)} ${kind} event(s) across ${String(input.events.length)} total`,
        suggestion: `consider whether ${kind} signals a place to tighten ${input.flow_description}`,
      }),
    );
  },
);

function synthetic_jsonl(): string {
  const events: ReadonlyArray<TrajectoryEvent> = [
    { kind: 'span_start', span_id: 's1', name: 'greet', run_id: 'run-a' },
    { kind: 'span_end', span_id: 's1', run_id: 'run-a' },
    { kind: 'span_start', span_id: 's2', name: 'greet', run_id: 'run-b' },
    { kind: 'emit', run_id: 'run-b', message: 'hello, world' },
    { kind: 'span_end', span_id: 's2', run_id: 'run-b' },
  ];
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

export async function run_learn(): Promise<{
  readonly events_considered: number;
  readonly run_ids: ReadonlyArray<string>;
  readonly proposals: ReadonlyArray<Improvement>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'fascicle-learn-'));
  const trajectory_path = join(dir, 'trajectory.jsonl');
  await writeFile(trajectory_path, synthetic_jsonl());

  try {
    const flow = learn({
      flow: studied_flow,
      source: { kind: 'paths', paths: [trajectory_path] },
      analyzer: tally_analyzer,
    });
    const result = await run(flow, undefined, { install_signal_handlers: false });
    return {
      events_considered: result.events_considered,
      run_ids: result.run_ids,
      proposals: result.proposals,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_learn()
    .then(({ events_considered, run_ids, proposals }) => {
      console.log(`events considered: ${String(events_considered)}`);
      console.log(`run ids:           ${run_ids.join(', ')}`);
      console.log('proposals:');
      for (const p of proposals) {
        console.log(`  - [${p.kind}] ${p.target}: ${p.rationale}`);
      }
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
