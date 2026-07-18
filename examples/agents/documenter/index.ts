/**
 * documenter: structured documentation agent.
 *
 * Markdown-defined: the system prompt lives in `./prompt.md`, the output
 * schema in `./schema.ts`. The factory in `./agent.ts` wires them through
 * `define_agent` with a `build_prompt` that flattens the file/symbol target
 * and the requested style into the user message.
 */

export { documenter } from './agent.js'
export type { DocumenterConfig } from './agent.js'

export { documenter_output_schema } from './schema.js'
export type {
  DocumenterInput,
  DocumenterOutput,
  DocumenterStyle,
  DocumenterTarget,
} from './schema.js'
