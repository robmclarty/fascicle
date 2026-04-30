/**
 * Prompts.
 *
 * The proposer prompt is fixed across rounds (no STOP-style self-mutation).
 * What varies is the context: parent code, lessons buffer, research
 * summary. Each is capped to keep total token count flat across iterations.
 */

import type { Brief, Metric } from './types.js'

export const SYSTEM_PROMPT = [
  'You are an iterative code optimizer. Your job is to propose ONE focused improvement to a single TypeScript file, expressed as the COMPLETE new contents of that file.',
  'You are inside a strict harness: a regression test suite (the gate) runs against every candidate. Any candidate that breaks tests dies before its score is even measured. You cannot win by deleting features.',
  'A pluggable metric scores each surviving candidate on a single number. The harness picks the best.',
  'Propose changes that have a clear mechanical reason to move the metric. Avoid speculative rewrites. Keep diffs focused.',
].join(' ')

export type ProposePromptArgs = {
  readonly brief: Brief
  readonly parent_content: string
  readonly parent_score: number
  readonly lessons: string
  readonly research: string
  readonly proposer_id: string
  readonly round: number
}

function describe_metric(metric: Metric): string {
  const verb = metric.direction === 'minimize' ? 'lower is better' : 'higher is better'
  return `Metric: ${metric.name} (${verb})`
}

export function propose_prompt(args: ProposePromptArgs): string {
  const sections = [
    `# Round ${String(args.round)} (proposer ${args.proposer_id})`,
    '',
    `## Task`,
    args.brief.task,
    '',
    `## ${describe_metric(args.brief.metric)}`,
    `Current parent score: ${String(args.parent_score)}`,
    '',
    `## File you may edit`,
    `Path: ${args.brief.metric.mutable_path}`,
    '',
    `## Current contents`,
    '```typescript',
    args.parent_content,
    '```',
    '',
  ]

  if (args.research.trim().length > 0) {
    sections.push('## Techniques you might consider', args.research, '')
  }

  if (args.lessons.trim().length > 0) {
    sections.push('## Prior lessons', args.lessons, '')
  }

  sections.push(
    '## Output format',
    'Return JSON matching the response schema: a brief one-line `rationale`, then the COMPLETE new file `content`. Do not paste a diff. Do not output prose around the JSON.',
  )

  return sections.join('\n')
}

export const RESEARCH_SYSTEM_PROMPT = [
  'You are a research assistant. Given a code-improvement task, return 3-5 high-leverage techniques that experienced engineers would try first.',
  'Be concrete. Name specific patterns (streaming, single-pass, pre-compiled regex, vectorization, caching, algorithmic complexity). Avoid platitudes.',
  'Output a short bulleted markdown list. No prose intro.',
].join(' ')

export function research_prompt(brief: Brief): string {
  return [
    `Task: ${brief.task}`,
    `Metric: ${brief.metric.name} (${brief.metric.direction === 'minimize' ? 'lower is better' : 'higher is better'})`,
    'Return 3-5 high-leverage techniques. Bullets only.',
  ].join('\n')
}
