/**
 * Shared types and zod schemas for the pr-improve pipeline.
 *
 * The schemas are the contract between stages — each stage emits or consumes
 * a value that conforms to one of these. Schemas also drive the engine's
 * structured-output validation (`model_step({ schema })`), so the same shape
 * is enforced at the type level and at runtime.
 *
 * Field-level output rules live here in `.describe()`, not in the prompts:
 * the descriptions travel to the model as part of the JSON schema, so caps and
 * meanings have exactly one home and cannot drift from what is enforced. The
 * markdown prompts under `prompts/` carry the role and the judgment criteria.
 */

import { z } from 'zod'

const suggestion_schema = z.object({
  id: z.string().min(1).describe('Stable id for this suggestion, e.g. "RS-01".'),
  file: z.string().min(1).describe('Path of the file the suggestion targets.'),
  line_range: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .describe('Start and end line in the file, as [start, end].'),
  category: z.enum(['bug', 'clarity', 'naming', 'duplication', 'safety', 'perf']),
  severity: z.enum(['low', 'medium', 'high']),
  one_liner: z
    .string()
    .max(120)
    .describe('The problem in 120 characters or fewer. Detail belongs in rationale.'),
  rationale: z.string().min(1).describe('Why this is worth changing.'),
  proposed_change: z.string().min(1).describe('Sketch of the change to make.'),
})
export type Suggestion = z.infer<typeof suggestion_schema>

export const reviewer_output_schema = z.object({
  suggestions: z
    .array(suggestion_schema)
    .max(10)
    .describe('At most 10 suggestions. May be empty when the diff needs no changes.'),
})
export type ReviewerOutput = z.infer<typeof reviewer_output_schema>

const accepted_change_schema = z.object({
  suggestion_id: z.string().min(1).describe('Id of the reviewer suggestion being accepted.'),
  file: z.string().min(1).describe('Path of the file the change targets.'),
  one_liner: z.string().max(120).describe('The change in 120 characters or fewer.'),
  why_worth_it: z.string().min(1).describe('One sentence on why the change earns its cost.'),
})
export type AcceptedChange = z.infer<typeof accepted_change_schema>

const rejected_change_schema = z.object({
  suggestion_id: z.string().min(1).describe('Id of the reviewer suggestion being rejected.'),
  reason: z.string().min(1).describe('One sentence on why it does not meet the bar.'),
})
export type RejectedChange = z.infer<typeof rejected_change_schema>

export const pragmatist_output_schema = z.object({
  accepted: z
    .array(accepted_change_schema)
    .max(3)
    .describe('At most 3 accepted changes. Empty is a valid, successful outcome.'),
  rejected: z
    .array(rejected_change_schema)
    .describe('Every suggestion not accepted, each with its reason.'),
  constraints: z
    .array(z.string())
    .describe('Extra rules the builder must honor, e.g. "do not change the public API of foo()".'),
})
export type PragmatistOutput = z.infer<typeof pragmatist_output_schema>

const file_edit_schema = z.object({
  path: z.string().min(1).describe('Edited file, relative to the worktree root.'),
  one_liner: z.string().max(120).describe('What changed in this file, 120 characters or fewer.'),
})
export type FileEdit = z.infer<typeof file_edit_schema>

export const handoff_schema = z.object({
  files_touched: z.array(file_edit_schema).describe('Every file the build edited.'),
  deviations: z
    .array(z.string())
    .describe('Places the build departed from the spec, one sentence each. May be empty.'),
  summary: z.string().min(1).describe('Two sentences describing the build, for the PR comment.'),
})
export type Handoff = z.infer<typeof handoff_schema>

export const build_verdict_schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pass'),
    summary: z.string().min(1).describe('Two sentences suitable for a PR comment.'),
    rationale: z.string().min(1).describe('One paragraph justifying the pass.'),
  }),
  z.object({
    kind: z.literal('needs-changes'),
    feedback: z.string().min(1).describe('Concrete, actionable feedback for the next build round.'),
  }),
])
export type BuildVerdict = z.infer<typeof build_verdict_schema>

/**
 * Role-to-model table threaded into the flow as data.
 *
 * Lives here rather than in `flow.ts` or `engine.ts` because both need it:
 * `engine.ts` resolves it from env, `flow.ts` consumes it. Model ids are
 * opaque strings the engine passes verbatim to the provider, so every entry is
 * a real id for the configured provider, never a family shorthand.
 */
export type FlowModels = {
  readonly reviewer: string
  readonly pragmatist: string
  readonly builder: string
  readonly build_reviewer: string
}

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
