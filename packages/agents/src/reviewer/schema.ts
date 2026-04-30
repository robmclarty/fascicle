/**
 * Reviewer agent: input/output types and Zod output schema.
 */

import { z } from 'zod';

export const review_finding_schema = z.object({
  severity: z.enum(['info', 'minor', 'major', 'blocker']),
  file: z.string().optional(),
  line: z.number().int().optional(),
  category: z.string(),
  message: z.string(),
  suggestion: z.string().optional(),
});

export const reviewer_output_schema = z.object({
  findings: z.array(review_finding_schema),
  summary: z.string(),
});

export type ReviewFocus = 'correctness' | 'security' | 'style' | 'tests';

export type ReviewerInput = {
  readonly diff: string;
  readonly focus?: ReadonlyArray<ReviewFocus>;
};

export type ReviewFinding = z.infer<typeof review_finding_schema>;
export type ReviewerOutput = z.infer<typeof reviewer_output_schema>;
