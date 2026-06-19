/**
 * Outbound MCP: expose a composed fascicle flow as an MCP tool.
 *
 * `serve_flow` registers onto a caller-constructed `McpServer` (the caller owns
 * the transport, identity, and lifecycle, and can host many flows on one
 * server), so it needs only a type-only SDK import. The registered handler
 * drives the existing `run`, threading the per-request abort signal so an MCP
 * client cancellation aborts the in-flight flow, and maps the result into a
 * `CallToolResult`. A thrown flow becomes an `isError` result rather than a
 * JSON-RPC protocol error.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { z } from 'zod'
import { run } from '#core'
import type { Step, TrajectoryLogger } from '#core'
import { output_to_call_result } from './result_mapping.js'

export type ServeFlowOptions<i, o> = {
  server: McpServer
  flow: Step<i, o>
  name: string
  description: string
  input_schema: z.ZodType<i>
  trajectory?: TrajectoryLogger
  // Overrides the default value-to-CallToolResult mapping.
  to_result?: (output: o) => { text: string; structured?: Record<string, unknown> }
}

export function serve_flow<i, o>(options: ServeFlowOptions<i, o>): void {
  const { server, flow, name, description, input_schema, trajectory, to_result } = options
  server.registerTool(
    name,
    { description, inputSchema: input_schema },
    async (input: i, extra) => {
      try {
        const output = await run(flow, input, {
          install_signal_handlers: false,
          abort: extra.signal,
          ...(trajectory !== undefined ? { trajectory } : {}),
        })
        return output_to_call_result(output, to_result)
      } catch (err: unknown) {
        return {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        }
      }
    },
  )
}
