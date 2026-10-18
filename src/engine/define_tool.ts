/**
 * Typed tool definitions.
 *
 * A `Tool<i>` whose `execute` takes a typed input can't sit in `tools: Tool[]`:
 * `execute` is a function-typed property, so under strict function types its
 * parameter is checked contravariantly, and a function that wants
 * `{ city: string }` doesn't accept `unknown`. Writing every tool as
 * `Tool<unknown>` instead makes `execute` re-parse an input the engine has
 * already validated. `define_tool` infers the input type from `input_schema`,
 * types `execute` and `needs_approval` with it, and hands back a plain `Tool`.
 */

import type { Tool } from './types.js'

/**
 * Define a tool whose `execute` and `needs_approval` receive the input type
 * `input_schema` validates to, and return it as a plain `Tool` that any
 * `tools` list accepts. The widening is the one cast, and it is sound because
 * the tool loop validates every call's input against `input_schema` and
 * passes `execute` and `needs_approval` the validated value, never the raw
 * one; a call that fails validation goes back to the model as a tool error
 * and never reaches the tool. The spec comes back as the same object.
 */
export function define_tool<i, o>(spec: Tool<i, o>): Tool {
  // Sound because the loop only ever passes the validated input; see above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return spec as Tool
}
