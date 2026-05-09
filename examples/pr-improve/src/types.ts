/**
 * Shared types and zod schemas for the pr-improve pipeline.
 *
 * The schemas are the contract between stages — each stage emits or consumes
 * a value that conforms to one of these. Schemas also drive the engine's
 * structured-output validation (`model_call({ schema })`), so the same shape
 * is enforced at the type level and at runtime.
 */

import { z } from 'zod'

export const SuggestionSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  line_range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  category: z.enum(['bug', 'clarity', 'naming', 'duplication', 'safety', 'perf']),
  severity: z.enum(['low', 'medium', 'high']),
  one_liner: z.string().max(120),
  rationale: z.string().min(1),
  proposed_change: z.string().min(1),
})
export type Suggestion = z.infer<typeof SuggestionSchema>

export const ReviewerOutputSchema = z.object({
  suggestions: z.array(SuggestionSchema).max(10),
})
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>

export const AcceptedChangeSchema = z.object({
  suggestion_id: z.string().min(1),
  file: z.string().min(1),
  one_liner: z.string().max(120),
  why_worth_it: z.string().min(1),
})
export type AcceptedChange = z.infer<typeof AcceptedChangeSchema>

export const RejectedChangeSchema = z.object({
  suggestion_id: z.string().min(1),
  reason: z.string().min(1),
})
export type RejectedChange = z.infer<typeof RejectedChangeSchema>

export const PragmatistOutputSchema = z.object({
  accepted: z.array(AcceptedChangeSchema).max(3),
  rejected: z.array(RejectedChangeSchema),
  constraints: z.array(z.string()),
})
export type PragmatistOutput = z.infer<typeof PragmatistOutputSchema>

export const FileEditSchema = z.object({
  path: z.string().min(1),
  one_liner: z.string().max(120),
})
export type FileEdit = z.infer<typeof FileEditSchema>

export const HandoffSchema = z.object({
  files_touched: z.array(FileEditSchema),
  deviations: z.array(z.string()),
  summary: z.string().min(1),
})
export type Handoff = z.infer<typeof HandoffSchema>

export const BuildVerdictSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pass'),
    summary: z.string().min(1),
    rationale: z.string().min(1),
  }),
  z.object({
    kind: z.literal('needs-changes'),
    feedback: z.string().min(1),
  }),
])
export type BuildVerdict = z.infer<typeof BuildVerdictSchema>

export type PRContext = {
  readonly repo: string
  readonly number: number
  readonly base_branch: string
  readonly head_branch: string
  readonly title: string
  readonly diff: string
  readonly project_context: string
}

export type FinalResult =
  | {
      readonly kind: 'no_changes_proposed'
      readonly pr: PRContext
      readonly suggestions: ReadonlyArray<Suggestion>
    }
  | {
      readonly kind: 'did_not_converge'
      readonly pr: PRContext
      readonly rounds: number
      readonly suggestions: ReadonlyArray<Suggestion>
    }
  | {
      readonly kind: 'improvement_ready'
      readonly pr: PRContext
      readonly branch: string
      readonly handoff: Handoff
      readonly verdict: Extract<BuildVerdict, { kind: 'pass' }>
      readonly comment_body: string
      readonly suggestions: ReadonlyArray<Suggestion>
    }
