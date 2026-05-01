import { describe, expect, it } from 'vitest'
import { trajectory_event_schema } from '@repo/core'
import { http_logger, type HttpLoggerFetch } from '../http.js'

type Captured = {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function recording_fetch(): { calls: Captured[]; fetch: HttpLoggerFetch } {
  const calls: Captured[] = []
  const fetch: HttpLoggerFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    return { ok: true, status: 200 }
  }
  return { calls, fetch }
}

function failing_fetch(err: unknown): HttpLoggerFetch {
  return async () => {
    throw err
  }
}

function status_fetch(status: number): HttpLoggerFetch {
  return async () => ({ ok: status >= 200 && status < 300, status })
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

describe('http_logger', () => {
  it('POSTs each record as one NDJSON line and the bytes parse back via trajectory_event_schema', async () => {
    const { calls, fetch } = recording_fetch()
    const logger = http_logger({ url: 'http://localhost:4242/api/ingest', fetch })

    logger.record({ kind: 'emit', text: 'hello' })
    logger.record({ kind: 'emit', text: 'world' })
    await flush()

    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe('http://localhost:4242/api/ingest')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers['content-type']).toBe('application/x-ndjson')
    expect(calls[0]?.body.endsWith('\n')).toBe(true)

    for (const c of calls) {
      const parsed = trajectory_event_schema.parse(JSON.parse(c.body))
      expect(parsed.kind).toBe('emit')
    }
  })

  it('emits span_start and span_end with stable span_id and parses via the schema', async () => {
    const { calls, fetch } = recording_fetch()
    const logger = http_logger({ url: 'http://x/y', fetch })

    const id = logger.start_span('step', { id: 'a' })
    logger.end_span(id, { id: 'a' })
    await flush()

    expect(calls).toHaveLength(2)
    const start = trajectory_event_schema.parse(JSON.parse(calls[0]?.body ?? ''))
    const end = trajectory_event_schema.parse(JSON.parse(calls[1]?.body ?? ''))
    expect(start.kind).toBe('span_start')
    expect(end.kind).toBe('span_end')
    expect(start.span_id).toBe(id)
    expect(end.span_id).toBe(id)
  })

  it('attaches parent_span_id on a child span opened inside a parent', async () => {
    const { calls, fetch } = recording_fetch()
    const logger = http_logger({ url: 'http://x/y', fetch })

    const outer = logger.start_span('sequence', { id: 'seq_1' })
    const inner = logger.start_span('step', { id: 'a' })
    logger.end_span(inner, { id: 'a' })
    logger.end_span(outer, { id: 'seq_1' })
    await flush()

    const events = calls.map((c): Record<string, unknown> => JSON.parse(c.body) as Record<string, unknown>)
    const outer_start = events.find((e) => e['span_id'] === outer && e['kind'] === 'span_start')
    const inner_start = events.find((e) => e['span_id'] === inner && e['kind'] === 'span_start')
    expect(outer_start?.['parent_span_id']).toBeUndefined()
    expect(inner_start?.['parent_span_id']).toBe(outer)
  })

  it('drops events on transport error and invokes on_error', async () => {
    const errors: unknown[] = []
    const logger = http_logger({
      url: 'http://x/y',
      fetch: failing_fetch(new Error('econnrefused')),
      on_error: (err) => { errors.push(err) },
    })

    logger.record({ kind: 'emit', text: 'one' })
    await flush()

    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('econnrefused')
  })

  it('non-2xx responses invoke on_error with a descriptive error', async () => {
    const errors: unknown[] = []
    const logger = http_logger({
      url: 'http://x/y',
      fetch: status_fetch(500),
      on_error: (err) => { errors.push(err) },
    })

    logger.record({ kind: 'emit' })
    await flush()

    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toContain('500')
  })

  it('does not throw when on_error is omitted and the request fails', async () => {
    const logger = http_logger({
      url: 'http://x/y',
      fetch: failing_fetch(new Error('boom')),
    })
    expect(() => logger.record({ kind: 'emit' })).not.toThrow()
    await flush()
  })
})
