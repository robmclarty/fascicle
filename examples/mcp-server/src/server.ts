/**
 * mcp-server: a minimal Model Context Protocol server over stdio.
 *
 * Exposes three tools (add, reverse_text, word_count) and one resource
 * template (greeting://{name}). Registers them on an `McpServer`, then
 * serves over stdio so any MCP-capable host (Claude Desktop, Claude Code,
 * Cursor, an upstream agent) can connect.
 *
 * Run directly:
 *   pnpm --filter @repo/example-mcp-server start
 *
 * Smoke test (spawns this server, lists tools, calls each one):
 *   pnpm --filter @repo/example-mcp-server smoke
 *
 * Wire into Claude Code (.mcp.json at repo root):
 *   {
 *     "mcpServers": {
 *       "example": {
 *         "command": "pnpm",
 *         "args": ["--filter", "@repo/example-mcp-server", "start"]
 *       }
 *     }
 *   }
 */

import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'example-mcp-server',
  version: '0.0.0',
})

server.registerTool(
  'add',
  {
    title: 'Add',
    description: 'Add two numbers and return the sum.',
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }),
)

server.registerTool(
  'reverse_text',
  {
    title: 'Reverse text',
    description: 'Return the input string reversed.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: [...text].reverse().join('') }],
  }),
)

server.registerTool(
  'word_count',
  {
    title: 'Word count',
    description: 'Count words and characters in a string.',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => {
    const words = text.trim().split(/\s+/).filter(Boolean).length
    const chars = text.length
    return {
      content: [{ type: 'text', text: JSON.stringify({ words, chars }) }],
    }
  },
)

server.registerResource(
  'greeting',
  new ResourceTemplate('greeting://{name}', { list: undefined }),
  {
    title: 'Greeting',
    description: 'A personalized greeting for {name}.',
  },
  async (uri, { name }) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/plain',
        text: `Hello, ${String(name)}!`,
      },
    ],
  }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
