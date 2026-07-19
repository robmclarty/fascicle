/**
 * Shared types and the one model-boundary schema for docs-concierge.
 *
 * Citations are passage NUMBERS, not paths: a small model cannot misspell an
 * index, and the gate resolves numbers back to real sources deterministically.
 * Field-level output rules live in `.describe()` here, not in the prompt.
 */

import { z } from 'zod'

export const confidence_schema = z.enum(['low', 'medium', 'high'])
export type Confidence = z.infer<typeof confidence_schema>

export const answer_schema = z.object({
  abstain: z
    .boolean()
    .describe('True when the passages do not actually contain the answer.'),
  confidence: confidence_schema.describe(
    'high only when a passage supports the answer directly and unambiguously.',
  ),
  answer: z
    .string()
    .describe('The answer, grounded ONLY in the passages. Empty when abstaining.'),
  citations: z
    .array(z.number().int())
    .describe('1-based numbers of the passages relied on. Empty when abstaining.'),
})
export type Assessment = z.infer<typeof answer_schema>

export type Passage = {
  readonly path: string
  readonly heading: string
  readonly content: string
  readonly score: number
}

export type Citation = {
  readonly path: string
  readonly heading: string
}

export type AbstainReason =
  | 'model_abstained'
  | 'no_passages'
  | 'low_confidence'
  | 'invalid_citations'
  | 'empty_answer'

export type Outcome =
  | {
      readonly kind: 'answer'
      readonly text: string
      readonly confidence: Confidence
      readonly citations: ReadonlyArray<Citation>
    }
  | {
      readonly kind: 'abstain'
      readonly reason: AbstainReason
    }

export type AskInput = {
  readonly question: string
}

export type AnswererInput = {
  readonly question: string
  readonly passages: ReadonlyArray<Passage>
}
