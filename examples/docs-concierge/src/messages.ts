/**
 * Pure user-message assembly for the answerer. Passages are numbered so the
 * model can cite by index; the static role instruction lives in
 * `prompts/answerer.md`. No fascicle imports, no IO.
 */

import type { AnswererInput } from './types.js'

const MAX_PASSAGES_CHARS = 16_000

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...(truncated)`
}

export function format_answerer_message(input: AnswererInput): string {
  const passages =
    input.passages.length === 0
      ? '(none found)'
      : clip(
          input.passages
            .map((p, i) => `[${String(i + 1)}] source: ${p.path} / ${p.heading}\n${p.content}`)
            .join('\n\n'),
          MAX_PASSAGES_CHARS,
        )
  return `Question:
${input.question.length === 0 ? '(empty question)' : input.question}

Documentation passages (your only source of truth; cite by number):
${passages}`
}
