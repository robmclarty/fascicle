/**
 * hitl-http: end-to-end human-in-the-loop over HTTP.
 *
 * A flow drafts something, then `suspend`s at an approval gate.
 * `run.until_suspended` reports the pause as a typed outcome; the server
 * stashes the outcome's `resume` closure under an id and returns a pending
 * record (the "confirmation UI" payload). A human (here, a scripted client)
 * fetches the pending record, decides, and POSTs the decision back; the
 * server calls `resume(decision)` (a full re-run of the flow with the
 * decision as resume data) and returns the final result. Nothing blocks a
 * socket while waiting for the human.
 *
 * The store is an in-memory Map for brevity, and a closure cannot outlive
 * the process: a real deployment persists the original input (for example,
 * `filesystem_store` from `fascicle/adapters`, a DB, or a queue) and calls
 * `run.until_suspended` again after a restart to rebuild the outcome.
 *
 * Deterministic stub `fn` bodies — no engine layer, no network, no LLM calls.
 *
 * Run directly:
 *   pnpm exec tsx examples/hitl-http/main.ts
 */

import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import { z } from 'zod'
import { run, sequence, step, suspend, type RunOutcome } from 'fascicle'

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

type PendingApproval = {
  readonly brief: string
  readonly resume: (data: unknown) => Promise<RunOutcome<string>>
}

const pending = new Map<string, PendingApproval>()

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
          const outcome = await run.until_suspended(flow, input, {
            install_signal_handlers: false,
          })
          if (outcome.kind === 'done') {
            send(res, 200, { status: 'done', result: outcome.output })
            return
          }
          const id = randomUUID()
          pending.set(id, { brief: input.brief, resume: outcome.resume })
          send(res, 202, { status: 'pending', id, brief: input.brief })
          return
        }

        if (req.method === 'GET' && url.startsWith('/pending/')) {
          const id = url.slice('/pending/'.length)
          const entry = pending.get(id)
          if (entry === undefined) return send(res, 404, { error: 'unknown id' })
          return send(res, 200, { id, brief: entry.brief })
        }

        if (req.method === 'POST' && url.startsWith('/resume/')) {
          const id = url.slice('/resume/'.length)
          const entry = pending.get(id)
          if (entry === undefined) return send(res, 404, { error: 'unknown id' })
          const decision = decision_schema.parse(await read_json(req))
          const outcome = await entry.resume(decision)
          pending.delete(id)
          if (outcome.kind === 'suspended') {
            // A later gate would pend again under a fresh id; this flow has
            // exactly one gate, so the branch exists for shape completeness.
            const next_id = randomUUID()
            pending.set(next_id, { brief: entry.brief, resume: outcome.resume })
            return send(res, 202, { status: 'pending', id: next_id, brief: entry.brief })
          }
          return send(res, 200, { status: 'resumed', result: outcome.output })
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
