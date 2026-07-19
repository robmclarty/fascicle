/**
 * Stage: answerer, via `define_agent` from fascicle/agents.
 *
 * The whole model boundary is a markdown prompt plus an output schema, so
 * `define_agent` does the entire job: the markdown body becomes the system
 * prompt, `build_prompt` delegates user-message assembly to messages.ts, and
 * the returned step yields the schema-validated `Assessment` directly (no
 * GenerateResult envelope). The model is threaded as data from the app's
 * resolved table; a frontmatter `model` in the markdown would be the role
 * default if the app threaded nothing.
 */

import type { Engine, Step } from 'fascicle'
import { define_agent } from 'fascicle/agents'

import { format_answerer_message } from '../messages.js'
import { answer_schema, type AnswererInput, type Assessment } from '../types.js'

export function make_answerer(engine: Engine, model: string): Step<AnswererInput, Assessment> {
  return define_agent<AnswererInput, Assessment>({
    md_path: new URL('../prompts/answerer.md', import.meta.url),
    schema: answer_schema,
    engine,
    model,
    schema_repair_attempts: 2,
    build_prompt: (input) => format_answerer_message(input),
  })
}
