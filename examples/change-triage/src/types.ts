/**
 * Shared types and zod schemas for the change-triage pipeline.
 *
 * One schema sits at the single model boundary (`assessment_schema`); the
 * engine validates and repairs against it, so downstream code reads
 * `r.content` fully typed. Field-level output rules live in `.describe()`
 * here, not in the prompt, so there is exactly one home per rule.
 */

import { z } from 'zod'

export const severity_schema = z.enum(['low', 'medium', 'high', 'critical'])
export type Severity = z.infer<typeof severity_schema>

export const confidence_schema = z.enum(['low', 'medium', 'high'])
export type Confidence = z.infer<typeof confidence_schema>

export const assessment_schema = z.object({
  score: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('Release risk of merging this change set, 0 (safe) to 100 (dangerous).'),
  confidence: confidence_schema.describe('How confident you are in the score.'),
  summary: z
    .string()
    .min(1)
    .describe('One short paragraph explaining the score. No fix suggestions.'),
  factors: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .describe('Short kebab-case id. Reuse a detector signal id when one applies.'),
        severity: severity_schema,
        detail: z.string().min(1).describe('Why this factor raises or lowers risk.'),
      }),
    )
    .describe('A few high-signal factors. Empty is correct for a trivial, safe diff.'),
})
export type Assessment = z.infer<typeof assessment_schema>

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export type DiffLine = {
  readonly line: number
  readonly content: string
}

export type DiffFile = {
  readonly path: string
  readonly status: DiffStatus
  readonly added_lines: ReadonlyArray<DiffLine>
  readonly removed_count: number
  /** The raw diff text for just this file, verbatim. */
  readonly raw: string
}

/** A deterministic detector hit. No model involved in producing these. */
export type Signal = {
  readonly id: string
  readonly severity: Severity
  readonly detail: string
  readonly paths: ReadonlyArray<string>
}

/** A merged risk factor in the final report, tagged with where it came from. */
export type Factor = {
  readonly id: string
  readonly severity: Severity
  readonly detail: string
  readonly source: 'detector' | 'model'
}

export type Band = 'low' | 'medium' | 'high' | 'critical'

export type ScreenResult = {
  readonly screened: ReadonlyArray<DiffFile>
  readonly skipped: ReadonlyArray<string>
}

export type TriageInput = {
  readonly label: string
  readonly diff: string
}

export type TriageReport = {
  readonly label: string
  readonly score: number
  readonly band: Band
  readonly confidence: Confidence
  readonly summary: string
  readonly factors: ReadonlyArray<Factor>
  /** Paths whose content was withheld from the model by the privacy screen. */
  readonly screened_paths: ReadonlyArray<string>
}
