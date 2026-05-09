/**
 * Markdown renderers for run artifacts (IMPROVEMENT_SPEC, HANDOFF, PR_COMMENT).
 *
 * Pure string assembly. Imported by main.ts to write per-run files; never
 * imported by flow.ts (the flow doesn't render markdown — it produces the
 * structured `FinalResult` and the harness decides what to write).
 */

import type { LoopResult } from '@repo/fascicle'

import type { LoopState } from './state.js'
import type { FinalResult, Handoff, PRContext, PragmatistOutput, Suggestion } from './types.js'

export function render_improvement_spec(pr: PRContext, spec: PragmatistOutput): string {
  const accepted_lines =
    spec.accepted.length === 0
      ? '_No changes accepted._'
      : spec.accepted
          .map((c) => `- [${c.suggestion_id}] ${c.one_liner} — ${c.file} — ${c.why_worth_it}`)
          .join('\n')
  const rejected_lines =
    spec.rejected.length === 0
      ? '_None._'
      : spec.rejected.map((r) => `- [${r.suggestion_id}] ${r.reason}`).join('\n')
  const constraints_lines =
    spec.constraints.length === 0
      ? '_None._'
      : spec.constraints.map((c) => `- ${c}`).join('\n')
  return [
    `# Improvement Spec for PR #${String(pr.number)}`,
    '',
    `## Accepted changes (${String(spec.accepted.length)})`,
    accepted_lines,
    '',
    '## Rejected',
    rejected_lines,
    '',
    '## Constraints',
    constraints_lines,
    '',
  ].join('\n')
}

export function render_handoff(handoff: Handoff, pr: PRContext, round: number): string {
  const files =
    handoff.files_touched.length === 0
      ? '_None._'
      : handoff.files_touched.map((f) => `- \`${f.path}\` — ${f.one_liner}`).join('\n')
  const deviations =
    handoff.deviations.length === 0 ? '_None._' : handoff.deviations.map((d) => `- ${d}`).join('\n')
  return [
    `# HANDOFF — PR #${String(pr.number)} (round ${String(round)})`,
    '',
    '## Files touched',
    files,
    '',
    '## Deviations from spec',
    deviations,
    '',
    '## Summary',
    handoff.summary,
    '',
  ].join('\n')
}

export function render_pr_comment(branch: string, summary: string): string {
  return [`Improvement PR proposed: \`${branch}\``, '', summary].join('\n')
}

export function render_pr_comment_with_link(pr_url: string, summary: string): string {
  return [
    `An automated improvement PR has been opened against this PR's head branch: ${pr_url}`,
    '',
    summary,
  ].join('\n')
}

export function render_review_comment(suggestions: ReadonlyArray<Suggestion>): string {
  if (suggestions.length === 0) {
    return '_Reviewer found no issues._\n'
  }
  const sections = suggestions.map((s) => {
    const range = `${String(s.line_range[0])}-${String(s.line_range[1])}`
    return [
      `### \`${s.file}:${range}\` — ${s.one_liner}`,
      '',
      `_${s.category} · ${s.severity}_`,
      '',
      s.rationale,
      '',
      '**Proposed change:**',
      '',
      s.proposed_change,
    ].join('\n')
  })
  return [
    '## Automated review',
    '',
    `Found ${String(suggestions.length)} suggestion${suggestions.length === 1 ? '' : 's'}:`,
    '',
    sections.join('\n\n'),
    '',
  ].join('\n')
}

export function render_review_comment_empty(): string {
  return 'Review complete — no improvements suggested.\n'
}

export function render_no_pragmatic_followup(): string {
  return 'Of these suggestions, none met the bar for a pragmatic improvement. No improvement PR created.\n'
}

export function render_did_not_converge_followup(rounds: number): string {
  return `Could not converge on a satisfactory build after ${String(rounds)} round${rounds === 1 ? '' : 's'}. No improvement PR created.\n`
}

export function build_improvement_branch(pr: PRContext): string {
  return `fascicle/improve-${String(pr.number)}`
}

export function assemble_final_result(
  pr: PRContext,
  _spec: PragmatistOutput,
  loop_result: LoopResult<LoopState>,
  suggestions: ReadonlyArray<Suggestion>,
): FinalResult {
  const final_state = loop_result.value
  if (final_state.last_verdict?.kind === 'pass' && final_state.last_handoff !== null) {
    const branch = build_improvement_branch(pr)
    return {
      kind: 'improvement_ready',
      pr,
      branch,
      handoff: final_state.last_handoff,
      verdict: final_state.last_verdict,
      comment_body: render_pr_comment(branch, final_state.last_handoff.summary),
      suggestions,
    }
  }
  return { kind: 'did_not_converge', pr, rounds: loop_result.rounds, suggestions }
}
