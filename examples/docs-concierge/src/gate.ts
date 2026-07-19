/**
 * The deterministic gate: the model proposes, this function decides.
 *
 * One-way narrowing: the gate can turn a proposed answer into an abstention
 * but never the reverse, so the agent stays silent rather than confidently
 * wrong. Every reason is data (`AbstainReason`), and the whole policy is a
 * pure function, exhaustively testable without a model.
 */

import type { Assessment, Confidence, Outcome, Passage } from './types.js'

const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 }

export type GateOptions = {
  /** Minimum confidence to let an answer through. Default: medium. */
  readonly min_confidence?: Confidence
}

/** Remove bare citation markers like `[1]` or `[2, 3]` from prose (not markdown links). */
export function strip_citation_markers(text: string): string {
  return text
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\](?!\()/g, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .trim()
}

export function gate(
  assessment: Assessment,
  passages: ReadonlyArray<Passage>,
  options: GateOptions = {},
): Outcome {
  if (assessment.abstain) return { kind: 'abstain', reason: 'model_abstained' }
  if (passages.length === 0) return { kind: 'abstain', reason: 'no_passages' }

  const min = options.min_confidence ?? 'medium'
  if (CONFIDENCE_RANK[assessment.confidence] < CONFIDENCE_RANK[min]) {
    return { kind: 'abstain', reason: 'low_confidence' }
  }

  const cited = [...new Set(assessment.citations)]
    .map((n) => passages[n - 1])
    .filter((p): p is Passage => p !== undefined)
  if (cited.length === 0) return { kind: 'abstain', reason: 'invalid_citations' }

  const text = strip_citation_markers(assessment.answer)
  if (text.length === 0) return { kind: 'abstain', reason: 'empty_answer' }

  return {
    kind: 'answer',
    text,
    confidence: assessment.confidence,
    citations: cited.map((p) => ({ path: p.path, heading: p.heading })),
  }
}
