/**
 * Public surface for agents.
 *
 * One deep abstraction: `define_agent`, the markdown + schema loader that
 * folds a prompt file and an output schema into a `Step<input, output>`.
 * The module layers entirely on core and engine — no private imports.
 *
 * Reference agents built on this loader (reviewer, documenter, researcher)
 * live in `examples/agents/`; they are copy-pasteable demo code, not
 * library surface.
 */

export { define_agent } from './define_agent.js'
export type { AgentBuiltPrompt, DefineAgentConfig } from './define_agent.js'
