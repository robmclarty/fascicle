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

let failures = 0
function check(label: string, actual: string, expected: string): void {
  if (actual === expected) {
    console.log(`ok   ${label} = ${actual}`)
  } else {
    failures += 1
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`)
  }
}

try {
  const { tools } = await client.listTools()
  const tool_names = tools.map((t) => t.name)
  const missing = ['add', 'reverse_text', 'word_count'].filter((n) => !tool_names.includes(n))
  if (missing.length > 0) {
    failures += 1
    console.error(`FAIL tools: missing ${missing.join(', ')}`)
  } else {
    console.log(`ok   tools = ${tool_names.join(', ')}`)
  }

  const sum = await client.callTool({
    name: 'add',
    arguments: { a: 2, b: 3 },
  })
  check('add(2, 3)', text_of(sum), '5')

  const reversed = await client.callTool({
    name: 'reverse_text',
    arguments: { text: 'fascicle' },
  })
  check('reverse_text("fascicle")', text_of(reversed), 'elcicsaf')

  const counts = await client.callTool({
    name: 'word_count',
    arguments: { text: 'one two three four' },
  })
  check('word_count("one two three four")', text_of(counts), '{"words":4,"chars":18}')

  const greeting = await client.readResource({ uri: 'greeting://world' })
  const first = greeting.contents[0]
  const greeting_text = first && 'text' in first && typeof first.text === 'string' ? first.text : ''
  check('greeting://world', greeting_text, 'Hello, world!')
} finally {
  await client.close()
}

if (failures > 0) {
  console.error(`\n${String(failures)} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')

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
