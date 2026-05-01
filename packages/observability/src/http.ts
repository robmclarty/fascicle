/**
 * HTTP push trajectory logger.
 *
 * Conforms to `TrajectoryLogger`. POSTs each event as a single line of
 * newline-delimited JSON to a configured URL. Pairs naturally with the
 * fascicle viewer's `/api/ingest` endpoint, but is a generic adapter — the
 * receiver can be anything that accepts NDJSON over HTTP.
 *
 * Failure policy: drop on transport error and invoke the optional `on_error`
 * callback. Never throws, never blocks the user's flow on a dev tool being
 * up. The flow always wins; the viewer is best-effort.
 *
 * Hierarchical span ids are tracked in-process, mirroring `filesystem_logger`
 * so the wire format is identical.
 */

import { randomUUID } from 'node:crypto'
import type { TrajectoryLogger } from '@repo/core'

export type HttpLoggerFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>

export type HttpLoggerOptions = {
  readonly url: string
  readonly fetch?: HttpLoggerFetch
  readonly on_error?: (err: unknown) => void
}

const default_fetch: HttpLoggerFetch = async (url, init) => {
  const res = await fetch(url, init)
  return { ok: res.ok, status: res.status }
}

export function http_logger(options: HttpLoggerOptions): TrajectoryLogger {
  const { url, on_error } = options
  const send = options.fetch ?? default_fetch
  const stack: string[] = []

  const post = (event: Record<string, unknown>): void => {
    const body = `${JSON.stringify(event)}\n`
    void send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body,
    })
      .then((res) => {
        if (!res.ok && on_error) on_error(new Error(`http_logger: POST ${url} -> ${res.status}`))
      })
      .catch((err: unknown) => {
        if (on_error) on_error(err)
      })
  }

  const start_span: TrajectoryLogger['start_span'] = (name, meta) => {
    const span_id = `${name}:${randomUUID().slice(0, 8)}`
    const parent_span_id = stack.length > 0 ? stack[stack.length - 1] : undefined
    const event: Record<string, unknown> = { kind: 'span_start', span_id, name, ...meta }
    if (parent_span_id !== undefined) event['parent_span_id'] = parent_span_id
    post(event)
    stack.push(span_id)
    return span_id
  }

  const end_span: TrajectoryLogger['end_span'] = (id, meta) => {
    post({ kind: 'span_end', span_id: id, ...meta })
    const idx = stack.lastIndexOf(id)
    if (idx !== -1) stack.splice(idx, 1)
  }

  const record: TrajectoryLogger['record'] = (event) => {
    post({ ...event })
  }

  return { record, start_span, end_span }
}
