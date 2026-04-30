/**
 * learn: offline self-improvement composer.
 *
 * `learn({ flow, source, analyzer })` reads recorded trajectory events from
 * past runs of `flow`, hands them to a user-supplied `analyzer` step alongside
 * `describe(flow)`, and returns the analyzer's proposals plus summary metadata
 * (events considered, distinct run ids).
 *
 * The amplify example is the *online* counterpart of this pattern: propose →
 * score → accept/reject inside a single run. `learn` is the *offline*
 * counterpart: reflect on what already happened across one or many recorded
 * runs without an evaluator in the loop.
 *
 * Implemented as a `compose`d `scope` of (compute meta) → (build LearnInput) →
 * (analyzer) → (wrap result with meta). No engine dependency; the analyzer
 * decides how to use the events.
 *
 * v1 supports the `events` source only. `paths` and `dir` sources are reserved
 * in the type union and throw at run time pending the file-IO implementation.
 */

import { compose, describe, scope, stash, step, use } from '@repo/core';
import type { Step, TrajectoryEvent } from '@repo/core';

export type TrajectorySource =
  | { readonly kind: 'events'; readonly events: ReadonlyArray<TrajectoryEvent> }
  | { readonly kind: 'paths'; readonly paths: ReadonlyArray<string> }
  | { readonly kind: 'dir'; readonly dir: string };

export type LearnInput = {
  readonly flow_description: string;
  readonly events: ReadonlyArray<TrajectoryEvent>;
  readonly prior?: unknown;
};

export type Improvement = {
  readonly target: string;
  readonly kind: 'prompt' | 'config' | 'structure' | 'note';
  readonly rationale: string;
  readonly suggestion: string;
};

export type LearnConfig<i extends LearnInput, o> = {
  readonly name?: string;
  readonly flow: Step<unknown, unknown>;
  readonly source: TrajectorySource;
  readonly analyzer: Step<i, o>;
  readonly filter?: (event: TrajectoryEvent) => boolean;
  readonly max_events?: number;
};

export type LearnResult<o> = {
  readonly proposals: o;
  readonly events_considered: number;
  readonly run_ids: ReadonlyArray<string>;
};

const DEFAULT_MAX_EVENTS = 10_000;
const META_KEY = '__learn_meta';

type LearnMeta = {
  readonly events_considered: number;
  readonly run_ids: ReadonlyArray<string>;
};

type MetaPlus = LearnMeta & {
  readonly events: ReadonlyArray<TrajectoryEvent>;
  readonly prior: unknown;
};

function resolve_events(source: TrajectorySource): ReadonlyArray<TrajectoryEvent> {
  if (source.kind === 'events') return source.events;
  throw new Error(
    `learn: source kind "${source.kind}" is not implemented yet; only "events" is supported in v1`,
  );
}

function collect_run_ids(events: ReadonlyArray<TrajectoryEvent>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const event of events) {
    const id = event['run_id'];
    if (typeof id === 'string' && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function learn<i extends LearnInput, o>(
  config: LearnConfig<i, o>,
): Step<unknown, LearnResult<o>> {
  const { flow, source, analyzer, filter } = config;
  const max = config.max_events ?? DEFAULT_MAX_EVENTS;

  const compute_meta = step('learn_compute_meta', (prior: unknown): MetaPlus => {
    const all = resolve_events(source);
    const filtered = filter ? all.filter(filter) : all;
    const capped = filtered.length > max ? filtered.slice(0, max) : filtered;
    return {
      events_considered: capped.length,
      run_ids: collect_run_ids(capped),
      events: capped,
      prior,
    };
  });

  const build_input = step(
    'learn_build_input',
    (meta: MetaPlus): LearnInput => ({
      flow_description: describe(flow),
      events: meta.events,
      prior: meta.prior,
    }),
  );

  const wrap_result = use(
    [META_KEY],
    (vars, proposals: o, ctx): LearnResult<o> => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const meta = vars[META_KEY] as LearnMeta;
      ctx.trajectory.record({
        kind: 'learn.summary',
        events_considered: meta.events_considered,
        run_ids: meta.run_ids,
      });
      return {
        proposals,
        events_considered: meta.events_considered,
        run_ids: meta.run_ids,
      };
    },
  );

  const inner = scope([
    stash(META_KEY, compute_meta),
    build_input,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    analyzer as unknown as Step<unknown, unknown>,
    wrap_result,
  ]);

  return compose(config.name ?? 'learn', inner);
}
