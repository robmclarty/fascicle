/**
 * hitl_http: end-to-end human-in-the-loop over HTTP.
 *
 * A flow drafts something, then `suspend`s at an approval gate. The first run
 * unwinds with a `suspended_error`; the server stashes the original input under
 * an id and returns a pending record (the "confirmation UI" payload). A human
 * (here, a scripted client) fetches the pending record, decides, and POSTs the
 * decision back; the server re-runs the flow with `resume_data` and returns the
 * final result. Nothing blocks a socket while waiting for the human.
 *
 * The store is an in-memory Map for brevity; a real deployment persists the
 * suspended input in a durable store (e.g. `filesystem_store` from
 * `fascicle/adapters`, a DB, or a queue) so a restart does not lose it.
 *
 * Deterministic stub `fn` bodies — no engine layer, no network, no LLM calls.
 *
 * Run directly:
 *   pnpm exec tsx examples/hitl_http.ts
 */

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import { z } from 'zod'
import { run, sequence, step, suspend, suspended_error } from 'fascicle'

type Brief = { readonly brief: string }
type Draft = { readonly brief: string; readonly draft: string }

const SUSPEND_ID = 'approve'
const brief_schema = z.object({ brief: z.string() })
const decision_schema = z.object({ approved: z.boolean() })

const flow = sequence([
  step('draft', ({ brief }: Brief): Draft => ({ brief, draft: `PR body for "${brief}"` })),
  suspend({
    id: SUSPEND_ID,
    on: () => {
      // Real deployments notify a human out of band here (Slack, email, a task
      // queue). The run then unwinds; the socket does not stay open.
    },
    resume_schema: decision_schema,
    combine: (draft: Draft, resume): string =>
      resume.approved ? `merged: ${draft.draft}` : `discarded: ${draft.draft}`,
  }),
])

const pending = new Map<string, Brief>()

async function read_json(stream: AsyncIterable<Uint8Array>): Promise<unknown> {
  const parts: Uint8Array[] = []
  for await (const part of stream) parts.push(part)
  return JSON.parse(Buffer.concat(parts).toString('utf8'))
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * The HITL server. Three routes: start a run, read a pending approval, resume
 * it with a decision.
 */
export function create_hitl_server(): Server {
  return createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/'
      try {
        if (req.method === 'POST' && url === '/run') {
          const input = brief_schema.parse(await read_json(req))
          try {
            const result = await run(flow, input, { install_signal_handlers: false })
            send(res, 200, { status: 'done', result })
          } catch (err) {
            if (!(err instanceof suspended_error)) throw err
            const id = randomUUID()
            pending.set(id, input)
            send(res, 202, { status: 'pending', id, brief: input.brief })
          }
          return
        }

        if (req.method === 'GET' && url.startsWith('/pending/')) {
          const id = url.slice('/pending/'.length)
          const input = pending.get(id)
          if (input === undefined) return send(res, 404, { error: 'unknown id' })
          return send(res, 200, { id, brief: input.brief })
        }

        if (req.method === 'POST' && url.startsWith('/resume/')) {
          const id = url.slice('/resume/'.length)
          const input = pending.get(id)
          if (input === undefined) return send(res, 404, { error: 'unknown id' })
          const decision = decision_schema.parse(await read_json(req))
          const result = await run(flow, input, {
            install_signal_handlers: false,
            resume_data: { [SUSPEND_ID]: decision },
          })
          pending.delete(id)
          return send(res, 200, { status: 'resumed', result })
        }

        send(res, 404, { error: 'not found' })
      } catch (err) {
        send(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    })()
  })
}

export async function run_hitl_http(): Promise<{
  readonly pending_status: number
  readonly resumed_result: unknown
}> {
  const server = create_hitl_server()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address')
  }
  const base = `http://127.0.0.1:${address.port}`
  try {
    const started = await fetch(`${base}/run`, {
      method: 'POST',
      body: JSON.stringify({ brief: 'add rate limiting' }),
    })
    const pending_status = started.status
    const { id } = z.object({ id: z.string() }).parse(await started.json())

    // A human would look at this before deciding.
    await fetch(`${base}/pending/${id}`)

    const resumed = await fetch(`${base}/resume/${id}`, {
      method: 'POST',
      body: JSON.stringify({ approved: true }),
    })
    const { result } = z.object({ result: z.unknown() }).parse(await resumed.json())
    return { pending_status, resumed_result: result }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_hitl_http()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
