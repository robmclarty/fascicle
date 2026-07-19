/**
 * Report assembly and output artifacts. `assemble_report` is the pure state
 * transition that applies the floor, derives the band, and merges detector
 * and model factors; `render_report` turns the result into markdown. No
 * model calls, no IO.
 */

import { band_for_score, floor_score } from './floor.js'
import type { Assessment, Factor, ScreenResult, Signal, TriageInput, TriageReport } from './types.js'

/**
 * Detector signals come first and keep their ids; model factors that restate
 * a detector id are folded into it (the detector detail wins), so the report
 * never lists the same risk twice.
 */
export function merge_factors(
  signals: ReadonlyArray<Signal>,
  model_factors: Assessment['factors'],
): ReadonlyArray<Factor> {
  const detector_ids = new Set(signals.map((s) => s.id))
  const from_detectors: Factor[] = signals.map((s) => ({
    id: s.id,
    severity: s.severity,
    detail: s.detail,
    source: 'detector',
  }))
  const from_model: Factor[] = model_factors
    .filter((f) => !detector_ids.has(f.id))
    .map((f) => ({ id: f.id, severity: f.severity, detail: f.detail, source: 'model' }))
  return [...from_detectors, ...from_model]
}

export function assemble_report(
  input: TriageInput,
  signals: ReadonlyArray<Signal>,
  screen: ScreenResult,
  assessment: Assessment,
): TriageReport {
  const score = floor_score(assessment.score, signals)
  return {
    label: input.label,
    score,
    band: band_for_score(score),
    confidence: assessment.confidence,
    summary: assessment.summary,
    factors: merge_factors(signals, assessment.factors),
    screened_paths: screen.skipped,
  }
}

export function render_report(report: TriageReport): string {
  const factors =
    report.factors.length === 0
      ? '(none)'
      : report.factors
          .map((f) => `- [${f.severity}] \`${f.id}\` (${f.source}): ${f.detail}`)
          .join('\n')
  const screened =
    report.screened_paths.length === 0
      ? ''
      : `\n\nWithheld from the model (sensitive paths):\n${report.screened_paths.map((p) => `- \`${p}\``).join('\n')}`
  return `# Release-risk triage: ${report.label}

**Score:** ${String(report.score)}/100 (**${report.band}**, confidence ${report.confidence})

${report.summary}

## Factors

${factors}${screened}
`
}
