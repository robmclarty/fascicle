/**
 * Child process for the stdio MCP server test.
 *
 * A real MCP server on the MCP SDK's own stdio transport, started by
 * `stdio_mcp_server.test.ts` the way an ACP session starts a server the
 * editor sent: by `mcp_client`, from the session's entry. It reports how it
 * was started, so the test can hold the spawn to what the entry said.
 *
 * Tools:
 *   - 'echo': answers `echo: <text>` for the `text` it was given.
 *   - 'started': answers, as JSON, this process's pid, the arguments after
 *     the script, its cwd, the `HARNESS_MARK` variable, and whether the
 *     `HARNESS_AGENT_ONLY` variable reached it.
 *
 * The process ends when its stdin does, since nothing else keeps it alive.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'stdio-mcp-harness', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'echo',
      description: 'Answer with the text it was given.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    { name: 'started', description: 'Report how this process was started.', inputSchema: { type: 'object' } },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const { name, arguments: input } = request.params
  if (name === 'echo') return { content: [{ type: 'text', text: `echo: ${String(input?.['text'])}` }] }
  if (name === 'started') {
    const report = {
      pid: process.pid,
      args: process.argv.slice(2),
      cwd: process.cwd(),
      mark: process.env['HARNESS_MARK'] ?? null,
      agent_only: process.env['HARNESS_AGENT_ONLY'] !== undefined,
    }
    return { content: [{ type: 'text', text: JSON.stringify(report) }] }
  }
  return { isError: true, content: [{ type: 'text', text: `no tool named ${name}` }] }
})

await server.connect(new StdioServerTransport())
