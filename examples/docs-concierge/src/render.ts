/**
 * Output rendering for the shell. Pure string assembly over the typed
 * Outcome; no model calls, no IO.
 */

import type { Outcome } from './types.js'

const ABSTAIN_TEXT: Readonly<Record<string, string>> = {
  model_abstained: 'the docs do not cover this',
  no_passages: 'no relevant docs were found',
  low_confidence: 'the answer was not confident enough to share',
  invalid_citations: 'the answer did not cite any retrieved passage',
  empty_answer: 'the answer was empty once markers were stripped',
}

export function render_human(outcome: Outcome): string {
  if (outcome.kind === 'abstain') {
    return `No confident answer (${ABSTAIN_TEXT[outcome.reason] ?? outcome.reason}). Leaving this one for a human.\n`
  }
  const sources = outcome.citations.map((c) => `- ${c.path} / ${c.heading}`).join('\n')
  return `${outcome.text}\n\nSources (confidence: ${outcome.confidence}):\n${sources}\n`
}

export function render_json(outcome: Outcome): string {
  return `${JSON.stringify(outcome, null, 2)}\n`
}
