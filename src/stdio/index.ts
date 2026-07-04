/**
 * Stdio subpath for fascicle: run a flow as somebody's child process.
 *
 * `run_stdio` is the whole child contract in one call: JSON on stdin, exactly
 * one JSON result on stdout, trajectory and errors on stderr, exit code as the
 * verdict. It is a library function the author calls from their own entry
 * point; fascicle still ships no generic runner CLI. For a stateful
 * MCP-over-stdio session, use `serve_flow` from `fascicle/mcp` instead.
 *
 * `execute_stdio` is the same contract over injected io, for callers (and
 * tests) that want the outcome as a value instead of an exit.
 */

export { run_stdio } from './run_stdio.js'
export { execute_stdio } from './execute_stdio.js'
export type { RunStdioOptions, StdioFailure, StdioOutcome, StdioIo } from './execute_stdio.js'
