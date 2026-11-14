/**
 * Flows and fixtures the a2a tests share: stub steps with a gate between
 * them, a step that streams text the way a model call does, and a step that
 * waits until a test lets it go.
 */

import { z } from 'zod'
import { sequence, step, suspend } from '#core'
import type { RunContext, Step } from '#core'
import type { A2aCard } from '../../types.js'

export const CARD: A2aCard = {
  name: 'release-notes',
  description: 'Drafts release notes and publishes them once they are approved.',
  url: 'http://agent.test/',
  skills: [{ id: 'notes', name: 'Release notes', description: 'Drafts and publishes release notes.' }],
}

/**
 * Record `text` on the run's trajectory as a model call's text chunk would
 * be, under `step_id`, when the run asked for chunks.
 */
export function say(ctx: RunContext, step_id: string, text: string): void {
  if (!ctx.streaming) return
  ctx.trajectory.record({ kind: 'model_chunk', step_id, chunk: { kind: 'text', text, step_index: 0 } })
}

/**
 * A step that streams each of `chunks` and returns them joined.
 */
export function speaker(id: string, chunks: ReadonlyArray<string>): Step<string, string> {
  return step(
    id,
    (_: string, ctx) => {
      for (const chunk of chunks) say(ctx, id, chunk)
      return chunks.join('')
    },
    { side_effect: true },
  )
}

/**
 * A gate that resumes on `{ approved }`.
 */
export function approval(id = 'approve', deadline_ms?: number): Step<string, string> {
  return suspend({
    id,
    ...(deadline_ms === undefined ? {} : { deadline_ms }),
    on: () => {},
    resume_schema: z.object({ approved: z.boolean() }),
    combine: (draft: string, decision) => `${draft} [${decision.approved ? 'approved' : 'refused'}]`,
  })
}

/**
 * Draft, wait for approval at `approve`, then publish. `drafts` counts how
 * often the draft step ran.
 */
export function gated_flow(drafts: { n: number } = { n: 0 }): Step<string, string> {
  return sequence([
    step('draft', (topic: string) => {
      drafts.n += 1
      return `notes on ${topic}`
    }),
    approval(),
    step('publish', (notes: string) => `published: ${notes}`),
  ])
}

export type Latch = {
  /** Resolves once the step has started. */
  readonly started: Promise<void>
  /** Lets the step finish with `value`. */
  readonly open: (value?: string) => void
  /** The reason the step's run was aborted with, once it was. */
  readonly aborted: () => unknown
}

/**
 * A step that waits until the test opens its latch, or until its run is
 * aborted, in which case it throws the abort's reason.
 */
export function latched(id = 'work'): { readonly flow: Step<string, string>; readonly latch: Latch } {
  const started = Promise.withResolvers<void>()
  const opened = Promise.withResolvers<string>()
  let reason: unknown
  const flow = step(id, async (input: string, ctx) => {
    started.resolve()
    const aborted = new Promise<never>((_resolve, reject) => {
      ctx.abort.addEventListener('abort', () => {
        reason = ctx.abort.reason
        reject(reason instanceof Error ? reason : new Error(String(reason)))
      })
    })
    const value = await Promise.race([opened.promise, aborted])
    return `${input}: ${value}`
  })
  return {
    flow,
    latch: {
      started: started.promise,
      open: (value = 'done') => {
        opened.resolve(value)
      },
      aborted: () => reason,
    },
  }
}
