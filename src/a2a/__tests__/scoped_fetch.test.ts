import { describe, expect, it } from 'vitest'
import { scoped_fetch } from '../scoped_fetch.js'

type Seen = { url: string; auth: string | null; kept: string | null }

function recorder(): { seen: Seen[]; inner: typeof fetch } {
  const seen: Seen[] = []
  const inner: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const headers = new Headers(init?.headers)
    seen.push({ url, auth: headers.get('authorization'), kept: headers.get('x-kept') })
    return new Response('ok')
  }
  return { seen, inner }
}

const BASE = 'https://agent.example/a2a'
const TOKEN = { authorization: 'Bearer secret' }

describe('scoped_fetch', () => {
  it('adds the headers to a request for the configured origin and keeps the request own headers', async () => {
    const { seen, inner } = recorder()
    await scoped_fetch(BASE, TOKEN, inner)('https://agent.example/.well-known/agent-card.json', { headers: { 'x-kept': 'yes' } })
    expect(seen).toEqual([{ url: 'https://agent.example/.well-known/agent-card.json', auth: 'Bearer secret', kept: 'yes' }])
  })

  it('sends a request for another origin without the headers', async () => {
    const { seen, inner } = recorder()
    const send = scoped_fetch(BASE, TOKEN, inner)
    await send('https://elsewhere.example/rpc', { headers: { 'x-kept': 'yes' } })
    await send('http://agent.example/rpc')
    await send('https://agent.example:8443/rpc')
    expect(seen.map((s) => s.auth)).toEqual([null, null, null])
    expect(seen[0]?.kept).toBe('yes')
  })

  it('reads the origin from a URL object and from a Request', async () => {
    const { seen, inner } = recorder()
    const send = scoped_fetch(BASE, TOKEN, inner)
    await send(new URL('https://agent.example/rpc'))
    await send(new Request('https://agent.example/rpc'))
    await send(new URL('https://elsewhere.example/rpc'))
    await send(new Request('https://elsewhere.example/rpc'))
    expect(seen.map((s) => s.auth)).toEqual(['Bearer secret', 'Bearer secret', null, null])
  })

  it('runs a headers function before each request for the configured origin, and never for another', async () => {
    const { seen, inner } = recorder()
    let calls = 0
    const send = scoped_fetch(BASE, async () => ({ authorization: `Bearer ${String(++calls)}` }), inner)
    await send('https://agent.example/rpc')
    await send('https://elsewhere.example/rpc')
    await send('https://agent.example/rpc')
    expect(seen.map((s) => s.auth)).toEqual(['Bearer 1', null, 'Bearer 2'])
    expect(calls).toBe(2)
  })

  it('passes a request through untouched when no headers are configured', async () => {
    const { seen, inner } = recorder()
    await scoped_fetch(BASE, undefined, inner)('https://agent.example/rpc', { headers: { 'x-kept': 'yes' } })
    expect(seen).toEqual([{ url: 'https://agent.example/rpc', auth: null, kept: 'yes' }])
  })
})
