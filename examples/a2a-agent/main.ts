/**
 * a2a-agent: one flow served as an Agent2Agent (A2A) agent, and a second
 * flow that calls it, with a restart in the middle.
 *
 * The served agent writes release notes. It drafts them, stops at a gate to
 * ask whether to publish, and publishes once someone says yes. Its tasks are
 * durable runs, and both the runs and the task records live in one SQLite
 * file, so a task that waits for its answer outlives the server.
 *
 * The caller is a flow of its own, driven by `durable` over a store in
 * memory. Its `a2a_step` asks the agent for notes on v1.2, and the agent's
 * question comes back as a gate on the caller's own run. While both sides
 * wait, the example closes the server and serves the same flow again over
 * the same file. The caller's answer then reaches the task the first server
 * opened, which the second one finishes.
 *
 * Keyless by default: every step is a deterministic stub, and the only
 * network is localhost. Pass --model to have a model draft the notes
 * instead, on OpenRouter unless --provider names another
 * (../acp-agent/engines.ts lists them, along with the key each one reads).
 *
 * Run directly:
 *   pnpm exec tsx examples/a2a-agent/main.ts
 *   pnpm exec tsx examples/a2a-agent/main.ts --model anthropic/claude-sonnet-5.5
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { checkpoint, durable, model_step, sequence, step, suspend } from 'fascicle'
import type { DurableOutcome, Step, TrajectoryLogger } from 'fascicle'
import { a2a_step, serve_a2a, sqlite_task_store } from 'fascicle/a2a'
import type { A2aResult } from 'fascicle/a2a'
import { memory_store, sqlite_store } from 'fascicle/adapters'
import { engine_for, flag } from '../acp-agent/engines.js'

const RUN_ID = 'notes-v1.2'
const QUIET = { install_signal_handlers: false } as const
const RESTART_PAUSE_MS = 100

/**
 * The step that drafts the notes: a stub, or a model when one is named.
 */
function drafter(model: string | undefined, provider: string): Step<string, string> {
  if (model === undefined) {
    return step('draft', (version: string) => `${version}: faster cold starts, and the export bug is fixed.`, {
      description: 'draft the notes, the part that would cost money',
      side_effect: true,
    })
  }
  return model_step({
    id: 'draft',
    engine: engine_for(provider),
    model,
    system: 'Write two short sentences of release notes for the version the user names. Invent plausible changes.',
  })
}

/**
 * The flow the agent serves. The draft sits in a checkpoint, so the answer
 * to the gate doesn't pay for it a second time.
 */
export function build_notes_flow(draft: Step<string, string>): Step<string, string> {
  return sequence(
    [
      checkpoint(draft, { key: 'draft', description: 'keep the draft, so the answer never pays for it again' }),
      suspend({
        id: 'approve',
        description: 'ask whoever sent the task whether to publish',
        on: () => {},
        resume_schema: z.object({ approved: z.boolean() }),
        combine: (notes: string, answer) => (answer.approved ? notes : `withheld: ${notes}`),
      }),
      step('publish', (notes: string) => `Published. ${notes}`, { description: 'publish what was approved' }),
    ],
    { name: 'release_notes', description: 'draft release notes and publish them once they are approved' },
  )
}

/**
 * A port nothing listens on, found by binding one and letting it go. The
 * agent's card has to name the address before the server binds it.
 */
function free_port(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port to serve on'))
        else resolve(address.port)
      })
    })
  })
}

/**
 * Serve the notes flow on `port`, with its runs and its task records in the
 * SQLite file at `path`. Each call opens the file afresh, the way a new
 * process would.
 */
async function serve_notes(flow: Step<string, string>, port: number, path: string) {
  const runs = sqlite_store({ path })
  const tasks = sqlite_task_store({ path })
  const server = await serve_a2a({
    flow,
    card: {
      name: 'release-notes',
      description: 'Drafts release notes and publishes them once they are approved.',
      url: `http://127.0.0.1:${port}/`,
      skills: [{ id: 'notes', name: 'Release notes', description: 'Notes for the version you name.' }],
    },
    port,
    runs: durable({ store: runs }),
    task_store: tasks,
  })
  return {
    url: server.url,
    close: async () => {
      await server.close()
      runs.close()
      tasks.close()
    },
  }
}

/**
 * A trajectory logger that reports each state the remote task passes
 * through, which the `a2a_step` records as it hears of it.
 */
function state_log(on_state: (state: string) => void): TrajectoryLogger {
  return {
    record: (event) => {
      const status = event['a2a_status']
      if (typeof status !== 'object' || status === null || !('state' in status)) return
      on_state(String(status.state))
    },
    start_span: (name) => name,
    end_span: () => {},
  }
}

/**
 * Ask the agent at `url` what state a task is in.
 */
async function task_state(url: string, task_id: string): Promise<string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: task_id } }),
  })
  const body = z.object({ result: z.object({ status: z.object({ state: z.string() }) }) }).parse(await response.json())
  return body.result.status.state
}

/**
 * A one-line account of where the caller's run stands.
 */
function describe_outcome(outcome: DurableOutcome<string>): string {
  if (outcome.kind === 'done') return `done: ${outcome.output}`
  if (outcome.kind === 'busy') return 'busy'
  return `waiting at ${outcome.id}`
}

export async function run_a2a_agent(print: (line: string) => void = () => {}): Promise<{
  readonly asked: string
  readonly question: string
  readonly after_restart: string
  readonly answered: string
  readonly states: ReadonlyArray<string>
}> {
  const dir = mkdtempSync(join(tmpdir(), 'fascicle-a2a-agent-'))
  const path = join(dir, 'agent.db')
  const port = await free_port()
  const provider = flag('--provider') ?? 'openrouter'
  const notes_flow = build_notes_flow(drafter(flag('--model'), provider))
  const states: string[] = []
  const options = {
    ...QUIET,
    trajectory: state_log((state) => {
      states.push(state)
      print(`  task ${state}`)
    }),
  }
  let agent = await serve_notes(notes_flow, port, path)
  try {
    print(`serving release-notes at ${agent.url}`)
    const caller = sequence([
      a2a_step({ id: 'notes', url: agent.url, description: 'ask the release-notes agent' }),
      step('report', (result: A2aResult) => result.text),
    ])
    const runs = durable({ store: memory_store() })

    print('asking for notes on v1.2')
    const asked = await runs.start(RUN_ID, caller, 'v1.2', options)
    if (asked.kind !== 'suspended') throw new Error(`expected the agent to ask a question, got ${asked.kind}`)
    const question = z
      .object({ input: z.object({ task_id: z.string(), text: z.string() }) })
      .parse(asked.payload).input
    print(`the agent asks: ${question.text}`)

    print('restarting the agent over the same file')
    await agent.close()
    // A real restart takes longer than this one. The pause gives this
    // process's own HTTP client time to notice that the old server closed the
    // connections it was keeping, so it opens new ones to the new server.
    await new Promise((resolve) => setTimeout(resolve, RESTART_PAUSE_MS))
    agent = await serve_notes(notes_flow, port, path)
    const after_restart = await task_state(agent.url, question.task_id)
    print(`  task ${after_restart} (read back from the new server)`)

    print('answering: approved')
    const answered = await runs.resume(RUN_ID, caller, { [asked.id]: { approved: true } }, options)
    print(describe_outcome(answered))

    return {
      asked: describe_outcome(asked),
      question: question.text,
      after_restart,
      answered: describe_outcome(answered),
      states,
    }
  } finally {
    await agent.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_a2a_agent((line) => {
    console.log(line)
  }).catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
