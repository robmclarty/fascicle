import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliCompressSync, constants, deflateSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetch_url } from '../transport.js'
import type { AddressPolicy, ResolveHost, ResolvedAddress, TransportHead, TransportRequest } from '../types.js'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

type Site = {
  readonly port: number
  /** The requests the server saw, in order. */
  readonly seen: IncomingMessage[]
  /** How many sockets were opened to the server. */
  readonly connections: () => number
}

const OPEN: AddressPolicy = { allow_hosts: undefined, deny_hosts: [], allow_private: true }

const LOOPBACK: ResolvedAddress = { address: '127.0.0.1', family: 4 }

const servers: Server[] = []

/** Start a server on 127.0.0.1 and record what reaches it. */
async function serve(handler: Handler): Promise<Site> {
  const seen: IncomingMessage[] = []
  let connections = 0
  const server = createServer((req, res) => {
    seen.push(req)
    handler(req, res)
  })
  server.on('connection', () => {
    connections += 1
  })
  servers.push(server)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  return { port, seen, connections: () => connections }
}

/** A request with short limits, to which a test adds what it is about. */
function ask(url: string, extra: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url,
    policy: OPEN,
    fetch_limit_bytes: 1024 * 1024,
    timeout_ms: 2000,
    max_redirects: 5,
    user_agent: 'transport-test/1.0',
    abort: new AbortController().signal,
    ...extra,
  }
}

/** A resolver that answers every name with the loopback address. */
function to_loopback(): ReturnType<typeof vi.fn<ResolveHost>> {
  return vi.fn<ResolveHost>(() => Promise.resolve([LOOPBACK]))
}

/** The error a promise rejects with, or a failure when it resolves. */
async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work
  } catch (error) {
    if (error instanceof Error) return error
    throw new Error(`rejected with a value that is not an Error: ${String(error)}`, { cause: error })
  }
  throw new Error('expected the fetch to reject, and it resolved')
}

/** Answer 200 with a body and whatever headers a test wants. */
function reply(body: string | Buffer, headers: Record<string, string> = {}): Handler {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', ...headers })
    res.end(body)
  }
}

/** Brotli at its fastest setting, which is all a buffer of zeros needs. */
function quick_brotli(data: Buffer): Buffer {
  return brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } })
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => {
            resolve()
          })
        }),
    ),
  )
})

describe('fetch_url', () => {
  it('returns the status, the content type, the body, and the URL that answered', async () => {
    const site = await serve(reply('hello', { 'content-type': 'text/html; charset=utf-8' }))
    const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/page?q=1`))
    expect(response.url).toBe(`http://127.0.0.1:${site.port}/page?q=1`)
    expect(response.status).toBe(200)
    expect(response.content_type).toBe('text/html; charset=utf-8')
    expect(response.body.toString()).toBe('hello')
    expect(response.truncated).toBe(false)
    expect(site.seen[0]?.url).toBe('/page?q=1')
    expect(site.seen[0]?.method).toBe('GET')
  })

  it('sends the user agent, the encodings it can undo, an accept that prefers text, and no cookie or credential', async () => {
    const site = await serve(reply('ok'))
    await fetch_url(ask(`http://127.0.0.1:${site.port}/`))
    const headers = site.seen[0]?.headers
    expect(headers?.['user-agent']).toBe('transport-test/1.0')
    expect(headers?.['accept-encoding']).toBe('gzip, deflate, br')
    expect(headers?.accept).toBe('text/html, text/markdown;q=0.9, text/plain;q=0.9, */*;q=0.5')
    expect(headers?.cookie).toBeUndefined()
    expect(headers?.authorization).toBeUndefined()
  })

  it('leaves content_type undefined when the response has none', async () => {
    const site = await serve((_req, res) => {
      res.writeHead(200)
      res.end('bare')
    })
    const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`))
    expect(response.content_type).toBeUndefined()
    expect(response.body.toString()).toBe('bare')
  })

  it.each([404, 500])('returns a %d response and does not throw', async (status) => {
    const site = await serve((_req, res) => {
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end('nope')
    })
    const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`))
    expect(response.status).toBe(status)
    expect(response.body.toString()).toBe('nope')
  })

  it('returns an empty body for a response that has none', async () => {
    const site = await serve((_req, res) => {
      res.writeHead(204)
      res.end()
    })
    const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`))
    expect(response.status).toBe(204)
    expect(response.body.length).toBe(0)
    expect(response.truncated).toBe(false)
  })

  describe('the pin', () => {
    it('resolves a name once and connects to the address that was checked, keeping the name in Host', async () => {
      const site = await serve(reply('pinned'))
      const resolve = to_loopback()
      const response = await fetch_url(ask(`http://public.test:${site.port}/a`), { resolve })
      expect(response.body.toString()).toBe('pinned')
      expect(response.url).toBe(`http://public.test:${site.port}/a`)
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(resolve).toHaveBeenCalledWith('public.test')
      expect(site.seen[0]?.headers.host).toBe(`public.test:${site.port}`)
      expect(site.connections()).toBe(1)
    })

    it('never asks a rebinding resolver a second time, so its second answer reaches no socket', async () => {
      const remotes: Array<string | undefined> = []
      const site = await serve((req, res) => {
        remotes.push(req.socket.remoteAddress)
        reply('first answer')(req, res)
      })
      const answers: ResolvedAddress[][] = [[LOOPBACK], [{ address: '203.0.113.7', family: 4 }]]
      const resolve = vi.fn<ResolveHost>(() => {
        const next = answers.shift()
        return next === undefined ? Promise.reject(new Error('asked a third time')) : Promise.resolve(next)
      })
      const response = await fetch_url(ask(`http://rebind.test:${site.port}/`), { resolve })
      expect(response.body.toString()).toBe('first answer')
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(answers).toHaveLength(1)
      expect(remotes).toEqual(['127.0.0.1'])
    })

    it('connects to the first address when a name has several', async () => {
      const site = await serve(reply('first'))
      const resolve = vi.fn<ResolveHost>(() =>
        Promise.resolve([LOOPBACK, { address: '203.0.113.7', family: 4 }]),
      )
      const response = await fetch_url(ask(`http://many.test:${site.port}/`), { resolve })
      expect(response.body.toString()).toBe('first')
      expect(site.connections()).toBe(1)
    })

    it('refuses a name that resolves to a loopback address and opens no connection', async () => {
      const site = await serve(reply('secret'))
      const resolve = to_loopback()
      const error = await rejection(
        fetch_url(ask(`http://inside.test:${site.port}/`, { policy: { ...OPEN, allow_private: false } }), {
          resolve,
        }),
      )
      expect(error.message).toBe(
        "inside.test resolves to 127.0.0.1, a loopback, private, or link-local address, so web_fetch won't reach it; set allow_private to read a server on your own network",
      )
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(site.connections()).toBe(0)
    })

    it('refuses a name with one public and one private address and opens no connection', async () => {
      const site = await serve(reply('secret'))
      const resolve = vi.fn<ResolveHost>(() =>
        Promise.resolve([{ address: '203.0.113.7', family: 4 }, LOOPBACK]),
      )
      const error = await rejection(
        fetch_url(ask(`http://mixed.test:${site.port}/`, { policy: { ...OPEN, allow_private: false } }), {
          resolve,
        }),
      )
      expect(error.message).toContain('mixed.test resolves to 127.0.0.1')
      expect(site.connections()).toBe(0)
    })

    it('checks an IP literal as it stands, with no resolution', async () => {
      const site = await serve(reply('literal'))
      const resolve = to_loopback()
      const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`), { resolve })
      expect(response.body.toString()).toBe('literal')
      expect(resolve).not.toHaveBeenCalled()

      const error = await rejection(
        fetch_url(ask(`http://127.0.0.1:${site.port}/`, { policy: { ...OPEN, allow_private: false } }), {
          resolve,
        }),
      )
      expect(error.message).toContain('127.0.0.1 resolves to 127.0.0.1')
      expect(resolve).not.toHaveBeenCalled()
      expect(site.connections()).toBe(1)
    })

    it('refuses the decimal form of a loopback address', async () => {
      const site = await serve(reply('secret'))
      const error = await rejection(
        fetch_url(ask(`http://2130706433:${site.port}/`, { policy: { ...OPEN, allow_private: false } })),
      )
      expect(error.message).toContain('resolves to 127.0.0.1')
      expect(site.connections()).toBe(0)
    })

    it('uses the system resolver when none is passed, and checks what it answers', async () => {
      const error = await rejection(
        fetch_url(ask('http://localhost:9/', { policy: { ...OPEN, allow_private: false } })),
      )
      expect(error.message).toMatch(/^localhost resolves to (127\.0\.0\.1|::1), a loopback/)
    })

    it('opens a socket of its own for every call', async () => {
      const site = await serve(reply('again'))
      const resolve = to_loopback()
      await fetch_url(ask(`http://public.test:${site.port}/`), { resolve })
      await fetch_url(ask(`http://public.test:${site.port}/`), { resolve })
      expect(resolve).toHaveBeenCalledTimes(2)
      expect(site.connections()).toBe(2)
      expect(site.seen[0]?.headers.connection).toBe('close')
    })
  })

  describe('redirects', () => {
    it.each([301, 302, 303, 307, 308])('follows a %d to its Location', async (status) => {
      const site = await serve((req, res) => {
        if (req.url === '/start') {
          res.writeHead(status, { location: '/end' })
          res.end('moved')
          return
        }
        reply('arrived')(req, res)
      })
      const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/start`))
      expect(response.url).toBe(`http://127.0.0.1:${site.port}/end`)
      expect(response.status).toBe(200)
      expect(response.body.toString()).toBe('arrived')
    })

    it.each([300, 304])('returns a %d as the final response even with a Location', async (status) => {
      const site = await serve((_req, res) => {
        res.writeHead(status, { location: '/elsewhere' })
        res.end()
      })
      const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/start`))
      expect(response.status).toBe(status)
      expect(response.url).toBe(`http://127.0.0.1:${site.port}/start`)
      expect(site.seen).toHaveLength(1)
    })

    it('returns a 302 with no Location as the final response', async () => {
      const site = await serve((_req, res) => {
        res.writeHead(302)
        res.end('lost')
      })
      const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`))
      expect(response.status).toBe(302)
      expect(response.body.toString()).toBe('lost')
    })

    it('resolves and checks every hop once, and carries nothing from one hop to the next', async () => {
      const site = await serve((req, res) => {
        if (req.headers.host?.startsWith('a.test') === true) {
          res.writeHead(302, { location: `http://b.test:${site.port}/landed`, 'set-cookie': 'session=1' })
          res.end()
          return
        }
        reply('on b')(req, res)
      })
      const resolve = to_loopback()
      const response = await fetch_url(ask(`http://a.test:${site.port}/`), { resolve })
      expect(response.url).toBe(`http://b.test:${site.port}/landed`)
      expect(response.body.toString()).toBe('on b')
      expect(resolve.mock.calls).toEqual([['a.test'], ['b.test']])
      expect(site.seen[1]?.headers.host).toBe(`b.test:${site.port}`)
      expect(site.seen[1]?.headers.cookie).toBeUndefined()
      expect(site.seen[1]?.headers.referer).toBeUndefined()
      expect(site.connections()).toBe(2)
    })

    it('refuses a redirect to a denied host and names the hop', async () => {
      const site = await serve((_req, res) => {
        res.writeHead(302, { location: 'http://internal.test/admin' })
        res.end()
      })
      const resolve = to_loopback()
      const error = await rejection(
        fetch_url(
          ask(`http://a.test:${site.port}/go`, { policy: { ...OPEN, deny_hosts: ['internal.test'] } }),
          { resolve },
        ),
      )
      expect(error.message).toBe(
        `redirect 1 (http://a.test:${site.port}/go to http://internal.test/admin) was refused: internal.test is on deny_hosts, so web_fetch won't fetch http://internal.test/admin`,
      )
      expect(error.cause).toBeInstanceOf(Error)
      expect(resolve.mock.calls).toEqual([['a.test']])
      expect(site.seen).toHaveLength(1)
    })

    it('refuses a redirect whose host fails the address check and counts the hop it happened on', async () => {
      const site = await serve((req, res) => {
        if (req.url === '/one') {
          res.writeHead(301, { location: '/two' })
          res.end()
          return
        }
        res.writeHead(302, { location: `http://nowhere.test:${site.port}/` })
        res.end()
      })
      const resolve = vi.fn<ResolveHost>((hostname) =>
        Promise.resolve(hostname === 'nowhere.test' ? [] : [LOOPBACK]),
      )
      const error = await rejection(fetch_url(ask(`http://a.test:${site.port}/one`), { resolve }))
      expect(error.message).toBe(
        `redirect 2 (http://a.test:${site.port}/two to http://nowhere.test:${site.port}/) was refused: nowhere.test did not resolve to any address`,
      )
      expect(resolve.mock.calls).toEqual([['a.test'], ['a.test'], ['nowhere.test']])
      expect(site.seen).toHaveLength(2)
    })

    it('refuses a redirect to a scheme other than http and https', async () => {
      const site = await serve((_req, res) => {
        res.writeHead(302, { location: 'file:///etc/passwd' })
        res.end()
      })
      const error = await rejection(fetch_url(ask(`http://127.0.0.1:${site.port}/`)))
      expect(error.message).toBe(
        `redirect 1 (http://127.0.0.1:${site.port}/ to file:///etc/passwd) was refused: web_fetch only fetches http and https URLs, and file:///etc/passwd is file`,
      )
    })

    it('keeps a password in a Location out of the refusal', async () => {
      const site = await serve((_req, res) => {
        res.writeHead(302, { location: 'http://alice:hunter2@b.test/x' })
        res.end()
      })
      const error = await rejection(fetch_url(ask(`http://127.0.0.1:${site.port}/`)))
      expect(error.message).toMatch(
        new RegExp(`^redirect 1 \\(http://127\\.0\\.0\\.1:${site.port}/ to http://b\\.test/x\\) was refused: `),
      )
      expect(error.message).not.toContain('hunter2')
      expect(error.message).not.toContain('alice')
    })

    it('rethrows a refusal of the first URL unchanged', async () => {
      const error = await rejection(
        fetch_url(ask('http://blocked.test/', { policy: { ...OPEN, deny_hosts: ['blocked.test'] } }), {
          resolve: to_loopback(),
        }),
      )
      expect(error.message).toBe("blocked.test is on deny_hosts, so web_fetch won't fetch http://blocked.test/")
    })

    it('follows max_redirects redirects and fails on one more, naming where it pointed', async () => {
      const site = await serve((req, res) => {
        const step = Number(req.url?.slice(1))
        if (step < 3) {
          res.writeHead(302, { location: `/${step + 1}` })
          res.end()
          return
        }
        reply('end of the chain')(req, res)
      })
      const whole = await fetch_url(ask(`http://127.0.0.1:${site.port}/0`, { max_redirects: 3 }))
      expect(whole.url).toBe(`http://127.0.0.1:${site.port}/3`)
      expect(whole.body.toString()).toBe('end of the chain')
      expect(site.seen).toHaveLength(4)

      const error = await rejection(fetch_url(ask(`http://127.0.0.1:${site.port}/0`, { max_redirects: 2 })))
      expect(error.message).toBe(
        `http://127.0.0.1:${site.port}/0 redirected more than 2 times; redirect 3 pointed at /3`,
      )
      expect(site.seen).toHaveLength(7)
    })

    it('follows no redirect when max_redirects is 0', async () => {
      const site = await serve((_req, res) => {
        res.writeHead(302, { location: 'http://user:hunter2@b.test/x' })
        res.end()
      })
      const error = await rejection(fetch_url(ask(`http://127.0.0.1:${site.port}/`, { max_redirects: 0 })))
      expect(error.message).toBe(
        `http://127.0.0.1:${site.port}/ redirected more than 0 times; redirect 1 pointed at http://b.test/x`,
      )
      expect(site.seen).toHaveLength(1)
    })

    it('does not call check_head for a redirect, and calls it once for the response that answered', async () => {
      const site = await serve((req, res) => {
        if (req.url === '/start') {
          res.writeHead(302, { location: '/end', 'content-type': 'text/x-redirect' })
          res.end()
          return
        }
        reply('done', { 'content-type': 'text/html' })(req, res)
      })
      const check_head = vi.fn<(head: TransportHead) => void>()
      await fetch_url(ask(`http://127.0.0.1:${site.port}/start`, { check_head }))
      expect(check_head.mock.calls).toEqual([
        [{ url: `http://127.0.0.1:${site.port}/end`, status: 200, content_type: 'text/html' }],
      ])
    })
  })

  describe('the body', () => {
    it('returns a body of exactly the limit whole', async () => {
      const site = await serve(reply('a'.repeat(1000)))
      const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`, { fetch_limit_bytes: 1000 }))
      expect(response.body.length).toBe(1000)
      expect(response.truncated).toBe(false)
    })

    it('cuts a body one byte past the limit, at the limit', async () => {
      const site = await serve(reply(`${'a'.repeat(1000)}b`))
      const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`, { fetch_limit_bytes: 1000 }))
      expect(response.body.toString()).toBe('a'.repeat(1000))
      expect(response.truncated).toBe(true)
    })

    it('cuts a body that arrives in many chunks at the limit', async () => {
      const site = await serve((_req, res) => {
        res.writeHead(200)
        res.write('abcd')
        setTimeout(() => {
          res.write('efgh')
          setTimeout(() => {
            res.end('ijkl')
          }, 10)
        }, 10)
      })
      const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`, { fetch_limit_bytes: 6 }))
      expect(response.body.toString()).toBe('abcdef')
      expect(response.truncated).toBe(true)
    })

    it('returns nothing and says so when the limit is 0', async () => {
      const site = await serve(reply('anything'))
      const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`, { fetch_limit_bytes: 0 }))
      expect(response.body.length).toBe(0)
      expect(response.truncated).toBe(true)
    })

    it.each([
      ['gzip', gzipSync],
      ['x-gzip', gzipSync],
      ['GZIP', gzipSync],
      [' gzip ', gzipSync],
      ['deflate', deflateSync],
      ['br', brotliCompressSync],
    ])('undoes a Content-Encoding of %j', async (encoding, compress) => {
      const text = 'the same words, again and again. '.repeat(200)
      const site = await serve(reply(compress(Buffer.from(text)), { 'content-encoding': encoding }))
      const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`))
      expect(response.body.toString()).toBe(text)
      expect(response.truncated).toBe(false)
    })

    it.each(['identity', 'zstd'])('passes a Content-Encoding of %s through as it came', async (encoding) => {
      const packed = gzipSync(Buffer.from('still packed'))
      const site = await serve(reply(packed, { 'content-encoding': encoding }))
      const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`))
      expect(response.body.equals(packed)).toBe(true)
    })

    it('counts the limit after decompression, so a gzip that unpacks past it is cut at the same count', async () => {
      const text = `${'a'.repeat(1000)}b`
      const packed = gzipSync(Buffer.from(text))
      expect(packed.length).toBeLessThan(100)
      const site = await serve(reply(packed, { 'content-encoding': 'gzip' }))
      const cut = await fetch_url(ask(`http://127.0.0.1:${site.port}/`, { fetch_limit_bytes: 1000 }))
      expect(cut.body.toString()).toBe('a'.repeat(1000))
      expect(cut.truncated).toBe(true)

      const whole = await fetch_url(ask(`http://127.0.0.1:${site.port}/`, { fetch_limit_bytes: 1001 }))
      expect(whole.body.toString()).toBe(text)
      expect(whole.truncated).toBe(false)
    })

    it.each([
      ['gzip', gzipSync],
      ['deflate', deflateSync],
      ['br', quick_brotli],
    ])('stops a %s bomb at the limit without unpacking the rest', async (encoding, compress) => {
      const unpacked = 32 * 1024 * 1024
      const packed = compress(Buffer.alloc(unpacked))
      expect(packed.length).toBeLessThan(64 * 1024)
      const site = await serve(reply(packed, { 'content-encoding': encoding }))
      const before = process.memoryUsage().arrayBuffers
      const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`, { fetch_limit_bytes: 4096 }))
      expect(response.body.length).toBe(4096)
      expect(response.body.every((byte) => byte === 0)).toBe(true)
      expect(response.truncated).toBe(true)
      expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(unpacked / 4)
    })

    it('fails with the encoding and the URL when a compressed body is not what it claims', async () => {
      const site = await serve(reply('this is not gzip', { 'content-encoding': 'gzip' }))
      const error = await rejection(fetch_url(ask(`http://127.0.0.1:${site.port}/bad`)))
      expect(error.message).toBe(
        `web_fetch could not decode the gzip body of http://127.0.0.1:${site.port}/bad: incorrect header check`,
      )
      expect(error.cause).toBeInstanceOf(Error)
    })

    it('fails when the connection closes before the body ends', async () => {
      const site = await serve((_req, res) => {
        res.writeHead(200, { 'content-length': '100' })
        res.write('partial')
        setTimeout(() => {
          res.destroy()
        }, 10)
      })
      const error = await rejection(fetch_url(ask(`http://127.0.0.1:${site.port}/cut`)))
      expect(error.message).toMatch(
        new RegExp(`^web_fetch could not reach http://127\\.0\\.0\\.1:${site.port}/cut: .+`),
      )
      expect(error.cause).toBeInstanceOf(Error)
    })

    it('closes its connection once the body is cut', async () => {
      const closed = vi.fn()
      const site = await serve((req, res) => {
        req.socket.on('close', closed)
        res.writeHead(200)
        res.write('x'.repeat(100))
      })
      const response = await fetch_url(ask(`http://127.0.0.1:${site.port}/`, { fetch_limit_bytes: 10 }))
      expect(response.body.length).toBe(10)
      await vi.waitFor(() => {
        expect(closed).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('check_head', () => {
    it('rejects with the very error check_head throws, reads no body, and closes the connection', async () => {
      const closed = vi.fn()
      const site = await serve((req, res) => {
        req.socket.on('close', closed)
        res.writeHead(200, { 'content-type': 'application/pdf' })
        res.write('%PDF')
      })
      const refused = new Error('not a page')
      const check_head = vi.fn<(head: TransportHead) => void>(() => {
        throw refused
      })
      const error = await rejection(fetch_url(ask(`http://127.0.0.1:${site.port}/file.pdf`, { check_head })))
      expect(error).toBe(refused)
      expect(check_head.mock.calls).toEqual([
        [{ url: `http://127.0.0.1:${site.port}/file.pdf`, status: 200, content_type: 'application/pdf' }],
      ])
      await vi.waitFor(() => {
        expect(closed).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('timeout_ms', () => {
    it('gives up on a server that never answers', async () => {
      const site = await serve(() => {})
      const error = await rejection(fetch_url(ask(`http://127.0.0.1:${site.port}/slow`, { timeout_ms: 40 })))
      expect(error.message).toBe(
        `http://127.0.0.1:${site.port}/slow did not answer within 40 ms, so web_fetch gave up`,
      )
    })

    it('gives up on a body that stalls', async () => {
      const closed = vi.fn()
      const site = await serve((req, res) => {
        req.socket.on('close', closed)
        res.writeHead(200)
        res.write('a start and then nothing')
      })
      const error = await rejection(fetch_url(ask(`http://127.0.0.1:${site.port}/stall`, { timeout_ms: 40 })))
      expect(error.message).toBe(
        `http://127.0.0.1:${site.port}/stall did not answer within 40 ms, so web_fetch gave up`,
      )
      await vi.waitFor(() => {
        expect(closed).toHaveBeenCalledTimes(1)
      })
    })

    it('gives up on a compressed body that stalls', async () => {
      const packed = gzipSync(Buffer.from('x'.repeat(5000)))
      const site = await serve((_req, res) => {
        res.writeHead(200, { 'content-encoding': 'gzip' })
        res.write(packed.subarray(0, 10))
      })
      const error = await rejection(fetch_url(ask(`http://127.0.0.1:${site.port}/`, { timeout_ms: 40 })))
      expect(error.message).toBe(`http://127.0.0.1:${site.port}/ did not answer within 40 ms, so web_fetch gave up`)
    })

    it('gives up on a resolver that never answers, and opens no connection', async () => {
      const site = await serve(reply('unreached'))
      const resolve = vi.fn<ResolveHost>(() => new Promise(() => {}))
      const error = await rejection(
        fetch_url(ask(`http://slow-dns.test:${site.port}/`, { timeout_ms: 40 }), { resolve }),
      )
      expect(error.message).toBe(
        `http://slow-dns.test:${site.port}/ did not answer within 40 ms, so web_fetch gave up`,
      )
      expect(site.connections()).toBe(0)
    })

    it('bounds the whole call, so slow hops add up, and names the hop it stopped on', async () => {
      const site = await serve((req, res) => {
        const step = Number(req.url?.slice(1))
        setTimeout(() => {
          res.writeHead(302, { location: `/${step + 1}` })
          res.end()
        }, 30)
      })
      const error = await rejection(
        fetch_url(ask(`http://127.0.0.1:${site.port}/0`, { timeout_ms: 75, max_redirects: 50 })),
      )
      expect(error.message).toMatch(
        new RegExp(`^http://127\\.0\\.0\\.1:${site.port}/[1-3] did not answer within 75 ms, so web_fetch gave up$`),
      )
      expect(site.seen.length).toBeLessThanOrEqual(4)
    })

    it('clears its timer and its abort listener when the call ends', async () => {
      const site = await serve(reply('quick'))
      const controller = new AbortController()
      const add = vi.spyOn(controller.signal, 'addEventListener')
      const remove = vi.spyOn(controller.signal, 'removeEventListener')
      const clear = vi.spyOn(globalThis, 'clearTimeout')
      try {
        await fetch_url(ask(`http://127.0.0.1:${site.port}/`, { abort: controller.signal }))
        expect(add).toHaveBeenCalledTimes(1)
        expect(remove).toHaveBeenCalledTimes(1)
        expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1])
        expect(clear).toHaveBeenCalled()
      } finally {
        clear.mockRestore()
      }
    })
  })

  describe('abort', () => {
    it('rejects with the abort reason when it is an error, before any connection', async () => {
      const site = await serve(reply('unreached'))
      const reason = new Error('the run was cancelled')
      const resolve = to_loopback()
      const error = await rejection(
        fetch_url(ask(`http://public.test:${site.port}/`, { abort: AbortSignal.abort(reason) }), { resolve }),
      )
      expect(error).toBe(reason)
      expect(resolve).not.toHaveBeenCalled()
      expect(site.connections()).toBe(0)
    })

    it('says the fetch was cancelled when the abort reason is not an error, with no password in the URL', async () => {
      const error = await rejection(
        fetch_url(ask('http://user:hunter2@public.test/page', { abort: AbortSignal.abort('stop') })),
      )
      expect(error.message).toBe('web_fetch was cancelled before http://public.test/page answered')
    })

    it('stops waiting on a server when the signal fires', async () => {
      const closed = vi.fn()
      const controller = new AbortController()
      const site = await serve((req) => {
        req.socket.on('close', closed)
        controller.abort('enough')
      })
      const error = await rejection(
        fetch_url(ask(`http://127.0.0.1:${site.port}/wait`, { abort: controller.signal })),
      )
      expect(error.message).toBe(`web_fetch was cancelled before http://127.0.0.1:${site.port}/wait answered`)
      await vi.waitFor(() => {
        expect(closed).toHaveBeenCalledTimes(1)
      })
    })

    it('stops reading a body when the signal fires', async () => {
      const controller = new AbortController()
      const reason = new Error('cancelled mid-body')
      const site = await serve((_req, res) => {
        res.writeHead(200)
        res.write('some of it')
        setTimeout(() => {
          controller.abort(reason)
        }, 10)
      })
      const error = await rejection(fetch_url(ask(`http://127.0.0.1:${site.port}/`, { abort: controller.signal })))
      expect(error).toBe(reason)
    })

    it('stops waiting on a resolver when the signal fires', async () => {
      const controller = new AbortController()
      const reason = new Error('cancelled during resolution')
      const resolve = vi.fn<ResolveHost>(() => {
        setTimeout(() => {
          controller.abort(reason)
        }, 5)
        return new Promise(() => {})
      })
      const error = await rejection(fetch_url(ask('http://public.test/', { abort: controller.signal }), { resolve }))
      expect(error).toBe(reason)
    })
  })

  describe('failures below HTTP', () => {
    it('names the URL and keeps the cause when the connection is refused', async () => {
      const site = await serve(reply('gone'))
      const port = site.port
      const server = servers.pop()
      await new Promise<void>((resolve) => {
        server?.close(() => {
          resolve()
        })
      })
      const error = await rejection(fetch_url(ask(`http://127.0.0.1:${port}/down`)))
      expect(error.message).toMatch(
        new RegExp(`^web_fetch could not reach http://127\\.0\\.0\\.1:${port}/down: .*ECONNREFUSED`),
      )
      expect(error.cause).toMatchObject({ code: 'ECONNREFUSED' })
    })

    it('names the URL and keeps the cause when the name does not resolve', async () => {
      const cause = new Error('getaddrinfo ENOTFOUND missing.test')
      const resolve = vi.fn<ResolveHost>(() => Promise.reject(cause))
      const error = await rejection(fetch_url(ask('http://missing.test/x'), { resolve }))
      expect(error.message).toBe('web_fetch could not reach http://missing.test/x: getaddrinfo ENOTFOUND missing.test')
      expect(error.cause).toBe(cause)
    })

    it('reports a resolver that rejects with something other than an error', async () => {
      const resolve = vi.fn<ResolveHost>(() => Promise.reject('no such host'))
      const error = await rejection(fetch_url(ask('http://missing.test/x'), { resolve }))
      expect(error.message).toBe('web_fetch could not reach http://missing.test/x: no such host')
      expect(error.cause).toBe('no such host')
    })
  })
})
