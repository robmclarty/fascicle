import { describe, expect, it, vi } from 'vitest'
import type { WebSearch } from '../types.js'
import { web_tools } from '../web_tools.js'

/** A backend that finds one page, whatever the query. */
function backend() {
  return vi.fn<WebSearch>(async () => [{ title: 'A page', url: 'https://example.com/a', snippet: 'About a.' }])
}

describe('web_tools', () => {
  it('returns web_fetch alone when it is given no options', () => {
    const tools = web_tools()

    expect(tools.map((tool) => tool.name)).toEqual(['web_fetch'])
  })

  it('returns web_fetch alone when the options carry no search', () => {
    const tools = web_tools({ allow_private: true })

    expect(tools.map((tool) => tool.name)).toEqual(['web_fetch'])
  })

  it('returns web_fetch and then web_search when the options carry a search', () => {
    const tools = web_tools({ search: backend() })

    expect(tools.map((tool) => tool.name)).toEqual(['web_fetch', 'web_search'])
  })

  it('marks both tools read-only', () => {
    const tools = web_tools({ search: backend() })

    expect(tools.map((tool) => tool.read_only)).toEqual([true, true])
  })

  it('asks for no approval on either tool unless the app passes needs_approval', () => {
    const tools = web_tools({ search: backend() })

    expect(tools.map((tool) => 'needs_approval' in tool)).toEqual([false, false])
  })

  it('passes needs_approval to web_fetch and never to web_search', () => {
    const needs_approval = vi.fn(() => true)
    const tools = web_tools({ search: backend(), needs_approval })

    expect(tools[0]?.needs_approval).toBe(needs_approval)
    expect(tools[1]?.needs_approval).toBeUndefined()
  })

  it('passes a needs_approval of false through as false', () => {
    const tools = web_tools({ needs_approval: false })

    expect(tools[0]?.needs_approval).toBe(false)
  })

  it('builds web_search around the search it was given', async () => {
    const search = backend()
    const abort = new AbortController().signal
    const tools = web_tools({ search })

    const result = await tools[1]?.execute({ query: 'a' }, { abort, tool_call_id: 'call_1', step_index: 0 })

    expect(search).toHaveBeenCalledWith({ query: 'a', limit: 8 }, { abort })
    expect(result).toBe('1. A page\n   https://example.com/a\n   About a.')
  })

  it('hands its options to web_fetch, so a bad limit fails when the tools are built', () => {
    expect(() => web_tools({ timeout_ms: 0 })).toThrow(
      'web_tools needs timeout_ms as a whole number of at least 1, and got 0',
    )
  })

  it('refuses a private address by default, with no resolver passed', async () => {
    const [fetch_tool] = web_tools()
    const abort = new AbortController().signal

    await expect(
      Promise.resolve(fetch_tool?.execute({ url: 'http://127.0.0.1:9/' }, { abort, tool_call_id: 'call_1', step_index: 0 })),
    ).rejects.toThrow(
      "127.0.0.1 resolves to 127.0.0.1, a loopback, private, or link-local address, so web_fetch won't reach it; set allow_private to read a server on your own network",
    )
  })
})
