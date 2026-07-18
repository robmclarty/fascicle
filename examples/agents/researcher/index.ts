/**
 * researcher: bespoke iterative research agent.
 *
 * Researcher cannot collapse to a single prompt — it iterates over injected
 * `search` and `fetch` callables, integrating results across rounds. The
 * factory and its loop logic live in `./agent.ts`; this barrel only re-exports
 * the public surface.
 */

export { researcher } from './agent.js'
export type { FetchFn, ResearcherConfig, SearchFn } from './agent.js'

export {
  research_source_schema,
  summarizer_output_schema,
} from './schema.js'
export type {
  ResearchDepth,
  ResearchSource,
  ResearcherInput,
  ResearcherOutput,
  SearchHit,
  SummarizerOutput,
} from './schema.js'
