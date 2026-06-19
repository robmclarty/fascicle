/**
 * reviewer: structured code-review agent.
 *
 * Markdown-defined: the system prompt lives in `./prompt.md`, the output
 * schema in `./schema.ts`. The factory in `./agent.ts` wires them through
 * `define_agent` with a `build_prompt` that formats the diff and any focus
 * areas as the user message.
 */

export { reviewer } from './agent.js'
export type { ReviewerConfig } from './agent.js'
