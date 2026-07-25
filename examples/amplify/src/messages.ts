/**
 * User-message builders. Pure string assembly from typed inputs.
 *
 * The proposer's role is fixed in `prompts/proposer.md`; what varies per call
 * is assembled here — parent code, the lessons buffer, the research summary.
 * Each is capped upstream so the token count stays flat across rounds.
 */

import { format_lessons } from './lessons.js'
import type { Brief, Metric, ProposerInput } from './types.js'

function describe_metric(metric: Metric): string {
  const verb = metric.direction === 'minimize' ? 'lower is better' : 'higher is better'
  return `Metric: ${metric.name} (${verb})`
}

export function format_propose_message(input: ProposerInput): string {
  const { brief } = input
  const sections = [
    `# Round ${String(input.round)} (proposer ${input.proposer_id})`,
    '',
    '## Task',
    brief.task,
    '',
    `## ${describe_metric(brief.metric)}`,
    `Current parent score: ${String(input.parent_score)}`,
    '',
    '## File you may edit',
    `Path: ${brief.metric.mutable_path}`,
    '',
    '## Current contents',
    '```typescript',
    input.parent_content,
    '```',
    '',
  ]

  if (input.research.trim().length > 0) {
    sections.push('## Techniques you might consider', input.research, '')
  }

  const lessons = format_lessons(input.lessons)
  if (lessons.length > 0) {
    sections.push('## Prior lessons', lessons, '')
  }

  return sections.join('\n')
}

export function format_research_message(brief: Brief): string {
  return [
    `Task: ${brief.task}`,
    describe_metric(brief.metric),
    'Return 3-5 high-leverage techniques. Bullets only.',
  ].join('\n')
}
