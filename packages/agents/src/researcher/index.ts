/**
 * researcher: bespoke iterative research agent.
 *
 * Researcher cannot collapse to a single prompt — it iterates over injected
 * `search` and `fetch` callables, integrating results across rounds. The
 * shape is: `loop` from `@repo/core` driving (search → pick top-k → fetch →
 * summarize → decide stop). The summarizer is itself a `define_agent`, so
 * the bespoke agent reuses the same loader the markdown-defined ones use.
 *
 * Caller-provided `search` and `fetch` keep the agent's only side-effects at
 * the boundary. `ctx.abort` is forwarded to both so cancellation propagates.
 */

import { compose, loop, step } from '@repo/core';
import type { RunContext, Step } from '@repo/core';
import type { Engine } from '@repo/engine';
import { define_agent } from '../define_agent.js';
import {
  summarizer_output_schema,
  type ResearchDepth,
  type ResearchSource,
  type ResearcherInput,
  type ResearcherOutput,
  type SearchHit,
  type SummarizerOutput,
} from './schema.js';

type SummarizerInput = {
  readonly original_query: string;
  readonly query: string;
  readonly notes_so_far: string;
  readonly pages: ReadonlyArray<{
    readonly url: string;
    readonly title?: string;
    readonly contents: string;
  }>;
};

export type SearchFn = (
  query: string,
  ctx: RunContext,
) => Promise<ReadonlyArray<SearchHit>>;

export type FetchFn = (url: string, ctx: RunContext) => Promise<string>;

export type ResearcherConfig = {
  readonly engine: Engine;
  readonly search: SearchFn;
  readonly fetch: FetchFn;
  readonly name?: string;
};

const DEPTH_CAPS: Record<ResearchDepth, { readonly rounds: number; readonly top_k: number }> = {
  shallow: { rounds: 1, top_k: 2 },
  standard: { rounds: 3, top_k: 3 },
  deep: { rounds: 5, top_k: 4 },
};

type ResearcherState = {
  readonly original_query: string;
  readonly query: string;
  readonly visited: ReadonlySet<string>;
  readonly sources: ReadonlyArray<ResearchSource>;
  readonly notes: string;
  readonly brief: string;
  readonly stop: boolean;
};

function format_summarizer_user(input: SummarizerInput): string {
  const pages_block = input.pages
    .map((p, i) => {
      const header = p.title !== undefined ? `${p.title} <${p.url}>` : `<${p.url}>`;
      return `[${String(i + 1)}] ${header}\n${p.contents}`;
    })
    .join('\n\n');
  return [
    `Original query: ${input.original_query}`,
    `Refined query for this round: ${input.query}`,
    '',
    `Notes so far:\n${input.notes_so_far === '' ? '(none yet)' : input.notes_so_far}`,
    '',
    `New pages:\n\n${pages_block}`,
  ].join('\n');
}

function build_summarizer(engine: Engine): Step<SummarizerInput, SummarizerOutput> {
  return define_agent<SummarizerInput, SummarizerOutput>({
    md_path: new URL('./summarizer.md', import.meta.url),
    schema: summarizer_output_schema,
    engine,
    build_prompt: (input) => format_summarizer_user(input),
  });
}

export function researcher(
  config: ResearcherConfig,
): Step<ResearcherInput, ResearcherOutput> {
  const summarizer = build_summarizer(config.engine);

  const guard = step<ResearcherState, { readonly stop: boolean; readonly state: ResearcherState }>(
    'researcher_guard',
    (state) => ({ stop: state.stop, state }),
  );

  function build_round(top_k: number): Step<ResearcherState, ResearcherState> {
    return step<ResearcherState, ResearcherState>(
      'researcher_round',
      async (state, ctx): Promise<ResearcherState> => {
        if (state.stop) return state;

        const hits = await config.search(state.query, ctx);
        const fresh = hits.filter((h) => !state.visited.has(h.url));
        if (fresh.length === 0) return { ...state, stop: true };
        const picked = fresh.slice(0, top_k);

        const pages: SummarizerInput['pages'] = await Promise.all(
          picked.map(async (h) => {
            const contents = await config.fetch(h.url, ctx);
            return h.title === undefined
              ? { url: h.url, contents }
              : { url: h.url, title: h.title, contents };
          }),
        );

        const summary = await summarizer.run(
          {
            original_query: state.original_query,
            query: state.query,
            notes_so_far: state.notes,
            pages,
          },
          ctx,
        );

        const next_visited = new Set(state.visited);
        for (const p of picked) next_visited.add(p.url);

        return {
          original_query: state.original_query,
          query: summary.refined_query,
          visited: next_visited,
          sources: [...state.sources, ...summary.new_sources],
          notes: summary.notes,
          brief: summary.brief,
          stop: summary.has_enough,
        };
      },
    );
  }

  function build_loop(depth: ResearchDepth): Step<ResearcherInput, ResearcherOutput> {
    const cap = DEPTH_CAPS[depth];
    const inner = loop<ResearcherInput, ResearcherState, ResearcherOutput>({
      init: (input): ResearcherState => ({
        original_query: input.query,
        query: input.query,
        visited: new Set<string>(),
        sources: [],
        notes: '',
        brief: '',
        stop: false,
      }),
      body: build_round(cap.top_k),
      guard,
      finish: (state): ResearcherOutput => ({
        brief: state.brief,
        sources: state.sources,
        notes: state.notes,
      }),
      max_rounds: cap.rounds,
    });
    return step<ResearcherInput, ResearcherOutput>(
      'researcher_inner',
      async (input, ctx): Promise<ResearcherOutput> => {
        const result = await inner.run(input, ctx);
        return result.value;
      },
    );
  }

  const dispatcher = step<ResearcherInput, ResearcherOutput>(
    'researcher_dispatcher',
    async (input, ctx): Promise<ResearcherOutput> => {
      const depth: ResearchDepth = input.depth ?? 'standard';
      const flow = build_loop(depth);
      return flow.run(input, ctx);
    },
  );

  return compose(config.name ?? 'researcher', dispatcher);
}
