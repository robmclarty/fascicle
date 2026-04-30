/**
 * Public surface for @repo/agents.
 *
 * Agents are factories returning `Step<input, output>`. Simple agents are
 * markdown + schema, loaded by `define_agent`. Agents that genuinely need
 * flow logic stay as bespoke TypeScript. The package layers entirely on
 * @repo/core, @repo/composites, and @repo/engine — no private imports.
 */

export { define_agent } from './define_agent.js'
export type { AgentBuiltPrompt, DefineAgentConfig } from './define_agent.js'

export { reviewer } from './reviewer/index.js'
export type { ReviewerConfig } from './reviewer/index.js'
export {
  review_finding_schema,
  reviewer_output_schema,
} from './reviewer/schema.js'
export type {
  ReviewFinding,
  ReviewFocus,
  ReviewerInput,
  ReviewerOutput,
} from './reviewer/schema.js'

export { documenter } from './documenter/index.js'
export type { DocumenterConfig } from './documenter/index.js'
export { documenter_output_schema } from './documenter/schema.js'
export type {
  DocumenterInput,
  DocumenterOutput,
  DocumenterStyle,
  DocumenterTarget,
} from './documenter/schema.js'

export { researcher } from './researcher/index.js'
export type {
  FetchFn,
  ResearcherConfig,
  SearchFn,
} from './researcher/index.js'
export {
  research_source_schema,
  summarizer_output_schema,
} from './researcher/schema.js'
export type {
  ResearchDepth,
  ResearchSource,
  ResearcherInput,
  ResearcherOutput,
  SearchHit,
  SummarizerOutput,
} from './researcher/schema.js'
