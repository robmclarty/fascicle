/**
 * Pure user-message assembly for the assessor call. Static instruction lives
 * in `prompts/assessor.md`; everything computed per run (the file list, the
 * detector signals, the screened diff) is formatted here and sent as the user
 * message. No fascicle imports, no IO.
 */

import type { DiffFile, ScreenResult, Signal, TriageInput } from './types.js'

const MAX_DIFF_CHARS = 24_000

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...(truncated)`
}

function format_files(files: ReadonlyArray<DiffFile>): string {
  if (files.length === 0) return '(no files)'
  return files.map((f) => `- ${f.path} (${f.status}, +${String(f.added_lines.length)}/-${String(f.removed_count)})`).join('\n')
}

function format_signals(signals: ReadonlyArray<Signal>): string {
  if (signals.length === 0) return '(none detected)'
  return signals
    .map((s) => {
      const where = s.paths.length > 0 ? ` [${s.paths.slice(0, 5).join(', ')}]` : ''
      return `- [${s.severity}] ${s.id}: ${s.detail}${where}`
    })
    .join('\n')
}

export function format_assessor_message(
  input: TriageInput,
  files: ReadonlyArray<DiffFile>,
  signals: ReadonlyArray<Signal>,
  screen: ScreenResult,
): string {
  const withheld =
    screen.skipped.length > 0
      ? `\nWithheld paths (content screened out; judge them from the file list and signals):\n${screen.skipped.map((p) => `- ${p}`).join('\n')}\n`
      : ''
  const diff = clip(screen.screened.map((f) => f.raw).join('\n'), MAX_DIFF_CHARS)
  return `Change set: ${input.label}

Changed files (${String(files.length)}):
${format_files(files)}

Deterministic signals already detected (corroborate or extend; do not contradict):
${format_signals(signals)}
${withheld}
Unified diff (sensitive paths withheld; may be truncated):
\`\`\`diff
${diff}
\`\`\``
}
