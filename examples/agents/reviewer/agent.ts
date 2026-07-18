/**
 * reviewer factory implementation.
 *
 * Wires the markdown system prompt (`./prompt.md`) and output schema
 * (`./schema.ts`) through `define_agent`, with a `build_prompt` that formats
 * the diff and any focus areas as the user message.
 */

import type { Engine, Step } from 'fascicle'
import { define_agent } from 'fascicle/agents'
import {
  reviewer_output_schema,
  type ReviewerInput,
  type ReviewerOutput,
} from './schema.js'

export type ReviewerConfig = {
  readonly engine: Engine
  readonly name?: string
}

export function reviewer(config: ReviewerConfig): Step<ReviewerInput, ReviewerOutput> {
  return define_agent<ReviewerInput, ReviewerOutput>({
    md_path: new URL('./prompt.md', import.meta.url),
    schema: reviewer_output_schema,
    engine: config.engine,
    ...(config.name !== undefined ? { name: config.name } : {}),
    build_prompt: (input) => {
      const focus =
        input.focus && input.focus.length > 0
          ? `Focus areas: ${input.focus.join(', ')}.\n\n`
          : ''
      return `${focus}Diff:\n\n${input.diff}`
    },
  })
}
