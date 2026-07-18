/**
 * Researcher agent: input/output types and the per-round summarizer schema.
 */

import { z } from 'zod'

export const research_source_schema = z.object({
  url: z.string(),
  title: z.string().optional(),
  quote: z.string().optional(),
})

export const summarizer_output_schema = z.object({
  notes: z.string(),
  brief: z.string(),
  refined_query: z.string(),
  has_enough: z.boolean(),
  new_sources: z.array(research_source_schema),
})

export type ResearchDepth = 'shallow' | 'standard' | 'deep'

export type ResearchSource = z.infer<typeof research_source_schema>
export type SummarizerOutput = z.infer<typeof summarizer_output_schema>

export type ResearcherInput = {
  readonly query: string
  readonly depth?: ResearchDepth
}

export type ResearcherOutput = {
  readonly brief: string
  readonly sources: ReadonlyArray<ResearchSource>
  readonly notes: string
}

export type SearchHit = {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
}
