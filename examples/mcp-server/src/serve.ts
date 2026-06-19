/**
 * Expose a composed fascicle flow as an MCP tool over stdio using the published
 * `serve_flow` from `fascicle/mcp`. Run:
 *
 *   pnpm --filter @repo/example-mcp-server serve
 *
 * Then point any MCP host (Claude Desktop, Cursor, an upstream agent) at this
 * command to call the `headline` tool.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { sequence, step } from 'fascicle'
import { serve_flow } from 'fascicle/mcp'

// A small two-step flow: normalize, then format. Any composed Step works here.
const headline = sequence([
  step('normalize', (input: { topic: string }) => input.topic.trim().toLowerCase()),
  step('format', (topic: string) => ({ headline: `Breaking: ${topic} changes everything` })),
])

const server = new McpServer({ name: 'fascicle-serve-flow', version: '0.0.0' })

serve_flow({
  server,
  flow: headline,
  name: 'headline',
  description: 'Turn a topic into a punchy headline.',
  input_schema: z.object({ topic: z.string() }),
})

const transport = new StdioServerTransport()
await server.connect(transport)
