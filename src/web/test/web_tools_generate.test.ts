/**
 * Both web tools under the engine's own tool loop.
 *
 * The unit tests call each tool's `execute` directly, which shows what a
 * tool throws and nothing about what the model sees afterwards. These tests
 * run the tools through `generate` on a scripted model, so they pin the
 * part an agent depends on: a refused fetch comes back to the model as a
 * tool error it can read, and the loop carries on to the next call.
 */

import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '#engine'
import { make_loop_engine } from '#testing'
import { web_tools } from '../index.js'
import type { WebSearch } from '../index.js'

type ToolMessage = Extract<Message, { role: 'tool' }>

type Page = {
  readonly url: string
  /** How many requests the server has answered. */
  readonly hits: () => number
}

const servers: Server[] = []

/**
 * Serve one plain-text page on a loopback port and count the requests it gets.
 *
 * The count is what shows a refusal happened before any connection, since a
 * refused fetch and a failed one both end in an error.
 */
async function serve_page(text: string): Promise<Page> {
  let hits = 0
  const server = createServer((_request, response) => {
    hits += 1
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(text)
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/notes`, hits: () => hits }
}

/** Close a server and wait until it has let go of its port. */
function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve()
    })
  })
}

/** The tool messages among the messages a request carried. */
function tool_messages(messages: ReadonlyArray<Message> | undefined): ToolMessage[] {
  return (messages ?? []).filter((message): message is ToolMessage => message.role === 'tool')
}

/** A search backend that finds one page, whatever the query. */
function one_result(): ReturnType<typeof vi.fn<WebSearch>> {
  return vi.fn<WebSearch>(async () => [
    { title: 'Fascicle', url: 'https://example.com/fascicle', snippet: 'A small bundle of fibres.' },
  ])
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close))
})

describe('web_tools under generate', () => {
  it('hands a refused fetch to the model as a tool error, and the loop goes on to a search and an answer', async () => {
    const page = await serve_page('the notes')
    const search = one_result()
    const { engine, requests } = make_loop_engine([
      [{ name: 'web_fetch', input: { url: page.url } }],
      [{ name: 'web_search', input: { query: 'fascicle', limit: 3 } }],
      'A fascicle is a small bundle of fibres.',
    ])

    const result = await engine.generate({ prompt: 'what is a fascicle?', tools: [...web_tools({ search })] })

    expect(result.content).toBe('A fascicle is a small bundle of fibres.')
    expect(result.steps.map((step) => step.finish_reason)).toEqual(['tool_calls', 'tool_calls', 'stop'])
    expect(page.hits()).toBe(0)
    const refusal =
      "127.0.0.1 resolves to 127.0.0.1, a loopback, private, or link-local address, so web_fetch won't reach it; " +
      'set allow_private to read a server on your own network'
    expect(tool_messages(requests[1]?.messages)).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_0_0',
        name: 'web_fetch',
        content: JSON.stringify({ error: refusal }),
        is_error: true,
      },
    ])
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0]?.[0]).toEqual({ query: 'fascicle', limit: 3 })
    const after_search = tool_messages(requests[2]?.messages)
    expect(after_search).toHaveLength(2)
    expect(after_search[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1_0',
      name: 'web_search',
      content: '1. Fascicle\n   https://example.com/fascicle\n   A small bundle of fibres.',
    })
  })

  it('refuses a file URL as a tool error, then reads a page as text once allow_private is set', async () => {
    const page = await serve_page('the notes')
    const { engine, requests } = make_loop_engine([
      [{ name: 'web_fetch', input: { url: 'file:///etc/passwd' } }],
      [{ name: 'web_fetch', input: { url: page.url } }],
      'The page says: the notes.',
    ])

    const result = await engine.generate({ prompt: 'read the notes', tools: [...web_tools({ allow_private: true })] })

    expect(result.content).toBe('The page says: the notes.')
    expect(tool_messages(requests[1]?.messages)).toEqual([
      {
        role: 'tool',
        tool_call_id: 'call_0_0',
        name: 'web_fetch',
        content: JSON.stringify({
          error: 'web_fetch only fetches http and https URLs, and file:///etc/passwd is file',
        }),
        is_error: true,
      },
    ])
    expect(page.hits()).toBe(1)
    expect(tool_messages(requests[2]?.messages)[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1_0',
      name: 'web_fetch',
      content: `URL: ${page.url}\nStatus: 200\n\nthe notes`,
    })
  })
})
