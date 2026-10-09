/**
 * durable-runs: a flow that waits on outside events, driven one event at a
 * time the way a webhook handler or a queue worker would drive it.
 *
 * Each event builds its own driver and its own copy of the flow over one
 * store, which is what a fresh process would do. A pull request opening
 * starts the run: it fetches the diff, drafts a review inside a checkpoint,
 * and stops at the CI gate with an hour's deadline. The CI webhook then
 * resumes it, and while that drive is still posting the review, the deadline
 * timer fires. The timer finds the run held and reports `busy`, so only one
 * decision ever reaches the gate. A redelivered webhook later finds the run
 * done and changes nothing.
 *
 * The draft ran once across all of it, because its checkpoint served every
 * later drive. The diff fetch ran again on the webhook's drive, and the
 * trajectory says so with a `step_replayed` event, which is the cue to
 * checkpoint it too.
 *
 * Deterministic stub `fn` bodies: no engine layer, no network, no LLM calls.
 * The store is `filesystem_store` in a temporary directory.
 *
 * Run directly:
 *   pnpm exec tsx examples/durable-runs/main.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  checkpoint,
  durable,
  is_step_replayed_event,
  sequence,
  step,
  suspend,
  type DurableOutcome,
  type TrajectoryLogger,
} from 'fascicle'
import { filesystem_store } from 'fascicle/adapters'

type PullRequest = { readonly pr: number }
type Gathered = { readonly pr: number; readonly diff: string }
type Draft = { readonly pr: number; readonly review: string }

// What the paid parts of the flow do, injected so the example can count the
// drafts and hold a drive in its post step while the timer fires.
type Effects = {
  readonly drafted: () => void
  readonly posting: () => Promise<void>
}

const RUN_ID = 'pr-42'
const HOUR_MS = 60 * 60 * 1000
const QUIET = { install_signal_handlers: false } as const

/**
 * Build the review flow. Every event builds it afresh, the way every process
 * would, and every build has the same shape, so the run accepts each one.
 */
export function build_review(effects: Effects) {
  return sequence(
    [
      step('gather', ({ pr }: PullRequest): Gathered => ({ pr, diff: `diff of #${pr}` }), {
        description: 'fetch the diff, a paid call this example leaves unprotected',
        side_effect: true,
      }),
      checkpoint(
        step(
          'draft',
          (gathered: Gathered): Draft => {
            effects.drafted()
            return { pr: gathered.pr, review: `review of the ${gathered.diff}` }
          },
          { description: 'draft the review, the expensive part', side_effect: true },
        ),
        { key: 'draft', description: 'keep the draft, so no later event pays for it' },
      ),
      suspend({
        id: 'ci',
        description: 'wait for CI, an hour at most',
        deadline_ms: HOUR_MS,
        on: () => {
          // The push already started CI. A gate that asks a person would
          // notify them here instead.
        },
        resume_schema: z.object({ green: z.boolean(), timed_out: z.boolean().optional() }),
        combine: (draft: Draft, ci) =>
          ci.green ? draft.review : `hold #${draft.pr}: ${ci.timed_out === true ? 'CI never reported' : 'CI failed'}`,
      }),
      step(
        'post',
        async (comment: string) => {
          await effects.posting()
          return `posted ${comment}`
        },
        { description: 'post the result on the pull request', side_effect: true },
      ),
    ],
    { name: 'review', description: 'review a pull request once CI reports' },
  )
}

/**
 * A trajectory logger that keeps only the ids of replayed steps.
 */
function replay_log(): { readonly logger: TrajectoryLogger; readonly replayed: string[] } {
  const replayed: string[] = []
  return {
    replayed,
    logger: {
      record: (event) => {
        if (is_step_replayed_event(event)) replayed.push(event.step_id)
      },
      start_span: (name) => name,
      end_span: () => {},
    },
  }
}

/**
 * A one-line account of an outcome.
 */
function describe_outcome(outcome: DurableOutcome<string>): string {
  if (outcome.kind === 'done') return `done: ${outcome.output}`
  if (outcome.kind === 'busy') return 'busy'
  const minutes = Math.round(((outcome.deadline_at ?? Date.now()) - Date.now()) / 60_000)
  return `waiting at ${outcome.id}, deadline in ${minutes} minutes`
}

export async function run_durable_runs(): Promise<{
  readonly opened: string
  readonly webhook: string
  readonly timer: string
  readonly redelivered: string
  readonly drafts: number
  readonly replayed: ReadonlyArray<string>
}> {
  const root_dir = mkdtempSync(join(tmpdir(), 'fascicle-durable-runs-'))
  let drafts = 0
  const in_post = Promise.withResolvers<void>()
  const posted = Promise.withResolvers<void>()
  const effects: Effects = {
    drafted: () => {
      drafts += 1
    },
    posting: async () => {
      in_post.resolve()
      await posted.promise
    },
  }
  // Each event gets a driver and a flow of its own, standing in for a fresh
  // process that shares nothing with the last one but the store.
  const event = () => ({
    runs: durable({ store: filesystem_store({ root_dir }) }),
    flow: build_review(effects),
  })
  const { logger, replayed } = replay_log()
  try {
    const opened = event()
    const started = await opened.runs.start(RUN_ID, opened.flow, { pr: 42 }, QUIET)

    const ci = event()
    const webhook = ci.runs.resume(RUN_ID, ci.flow, { ci: { green: true } }, { ...QUIET, trajectory: logger })
    await in_post.promise

    const deadline = event()
    const timer = await deadline.runs.resume(RUN_ID, deadline.flow, { ci: { green: false, timed_out: true } }, QUIET)
    posted.resolve()
    const finished = await webhook

    const retry = event()
    const redelivered = await retry.runs.resume(RUN_ID, retry.flow, { ci: { green: true } }, QUIET)

    return {
      opened: describe_outcome(started),
      webhook: describe_outcome(finished),
      timer: describe_outcome(timer),
      redelivered: describe_outcome(redelivered),
      drafts,
      replayed,
    }
  } finally {
    rmSync(root_dir, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  run_durable_runs()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2))
    })
    .catch((err: unknown) => {
      console.error(err)
      process.exit(1)
    })
}
