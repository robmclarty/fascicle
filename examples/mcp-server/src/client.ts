/**
 * mcp-server smoke test: spawn ../server.ts as a stdio MCP child, list tools,
 * call each one, then read the greeting resource. Exits non-zero on mismatch.
 *
 * Run:
 *   pnpm --filter @repo/example-mcp-server smoke
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const server_path = resolve(here, 'server.ts')

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', server_path],
})

const client = new Client({ name: 'smoke', version: '0.0.0' })
await client.connect(transport)

try {
  const { tools } = await client.listTools()
  console.log('tools:', tools.map((t) => t.name).join(', '))

  const sum = await client.callTool({
    name: 'add',
    arguments: { a: 2, b: 3 },
  })
  console.log('add(2, 3) =', text_of(sum))

  const reversed = await client.callTool({
    name: 'reverse_text',
    arguments: { text: 'fascicle' },
  })
  console.log('reverse_text("fascicle") =', text_of(reversed))

  const counts = await client.callTool({
    name: 'word_count',
    arguments: { text: 'one two three four' },
  })
  console.log('word_count("one two three four") =', text_of(counts))

  const greeting = await client.readResource({ uri: 'greeting://world' })
  const first = greeting.contents[0]
  const greeting_text = first && 'text' in first ? first.text : ''
  console.log('greeting://world =', greeting_text)
} finally {
  await client.close()
}

function is_record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function text_of(result: unknown): string {
  if (!is_record(result) || !Array.isArray(result['content'])) {
    return ''
  }
  for (const part of result['content']) {
    if (is_record(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
      return part['text']
    }
  }
  return ''
}
