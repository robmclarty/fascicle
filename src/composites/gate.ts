/**
 * gate: persist paid work before a human gate, never re-bill on resume.
 *
 * `gate(inner, config)` runs `inner`, checkpoints its result, then suspends
 * so a human can approve what was produced. The checkpoint write lands before
 * the suspend unwinds the run, so the expensive work (typically a paid model
 * call) survives the pause: a resume, or a fresh run after a process restart,
 * replays the result from the store instead of buying it again.
 *
 * Decisions this composite fixes, and why:
 *
 * - Checkpoint key: `gate:<config.id>`. Derived only from the user-supplied
 *   id, with no construction-time counters, so a flow rebuilt in a new
 *   process maps to the same stored result. The key is fixed per gate, which
 *   assumes a store scoped per logical job (the same assumption the
 *   checkpoint and resume docs make for fixed string keys). Inherited from
 *   `checkpoint`: a stored `null`/`undefined` counts as a miss, and the inner
 *   step must be named.
 * - A failed write fails the run: the checkpoint takes
 *   `on_write_error: 'fail'`, so the run stops before it suspends rather than
 *   ask for approval of a result that the store never kept, which a resume
 *   would replace by running `inner` again. A hand-built checkpoint before a
 *   `suspend` that shows its result should pass `'fail'` for the same reason.
 * - Suspend payload: follows the library's suspend contract, which raises
 *   `{ input }` on the `suspended_error`. Here that `input` is
 *   `format(result)` when `format` is given and the raw result otherwise, so
 *   `run.until_suspended` surfaces `{ input: <approver view> }` as the
 *   outcome payload. A `format` return value is used verbatim (even
 *   `undefined`): the approver view is the format's business. The store
 *   always holds the raw result; `format` shapes only the view.
 * - Resumed value: the inner result passes through unchanged. The resume
 *   decision is the approval signal only and is discarded, so any defined
 *   value counts as approval arriving (the schema accepts everything). A
 *   flow that needs decision-dependent output (approve vs reject branches)
 *   should use `suspend` directly, whose `combine` exists for exactly that.
 * - `store` is optional. Absent, the checkpoint falls back to the run's
 *   `checkpoint_store`; with neither, the gate still suspends and resumes
 *   in-process but a restart re-executes `inner`. Present, the gate-local
 *   store wins over the run-level one, because an explicit argument beats
 *   ambient configuration.
 * - The suspend's `on` hook is a noop: notification is the driver's job, and
 *   `run.until_suspended` already hands it the payload to render.
 */

import { assert_valid_step_id, checkpoint, compose, scope, stash, step, suspend, use } from '#core'
import type { CheckpointStore, RunContext, Step } from '#core'

export type GateConfig<o> = {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly store?: CheckpointStore
  readonly format?: (result: o) => unknown
}

// The gate has no opinion about the decision's shape, so its resume schema is
// the always-accepting Standard Schema, written inline because composites
// depend only on the public core surface.
const approval_schema = {
  '~standard': {
    version: 1,
    vendor: 'fascicle',
    validate: (value: unknown) => ({ value }),
  },
} as const

/**
 * Bind a gate-local store over the run context for the checkpoint beneath.
 *
 * `checkpoint` reads `ctx.checkpoint_store`, so scoping a store to one gate
 * means forking the context above it; contexts are plain spread-copied
 * values, which is what makes this possible with public primitives only. The
 * wrapper adopts the checkpointed step as its child so `describe` still shows
 * the persistence layer and the inner step beneath it.
 */
function bind_store<i, o>(persisted: Step<i, o>, store: CheckpointStore): Step<i, o> {
  const wrapper = step('bind_store', (input: i, ctx: RunContext) => {
    const forked: RunContext = { ...ctx, checkpoint_store: store }
    return forked.call(persisted, input)
  })
  return { ...wrapper, children: [persisted] }
}

/**
 * Build a Step that runs `inner`, checkpoints its result at `gate:<id>`, and
 * suspends with that result as the payload awaiting approval.
 *
 * On resume (any defined resume value) the gate resolves to the inner result
 * unchanged; the decision itself is discarded. On a re-run against the same
 * store, the checkpoint absorbs the replay so `inner` never re-executes.
 * Throws at construction time when `inner` is anonymous, because the cached
 * result must map back to a stable step, and when `config.id` isn't an
 * identifier, which it checks under its own name before its `suspend` sees
 * the id.
 *
 * Implemented as a `compose`d `scope`: the checkpointed result is stashed,
 * projected into the approver's view, and handed to `suspend`; the suspend's
 * `combine` returns a `use` step that restores the stashed result, which is
 * how the decision stays signal-only.
 */
export function gate<i, o>(inner: Step<i, o>, config: GateConfig<o>): Step<i, o> {
  if (inner.anonymous === true) {
    throw new Error(
      "gate requires a named inner step, got anonymous — give the inner step an id with step('id', fn)",
    )
  }
  const { id, store, format } = config
  assert_valid_step_id(id, 'gate id', 'put the label in name')

  const checkpointed = checkpoint(inner, { key: `gate:${id}`, on_write_error: 'fail' })
  const persisted = store === undefined ? checkpointed : bind_store(checkpointed, store)

  const restore = use(['result'], (vars) => {
    // The stash below wrote the checkpointed inner result under this key, so
    // the read-back re-asserts its type.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return vars['result'] as o
  })

  const approval = suspend<unknown, o, unknown>({
    id,
    on: () => {},
    resume_schema: approval_schema,
    combine: () => restore,
  })

  const body: Step<i, o> = scope([
    stash('result', persisted),
    step('project_payload', (result: o) => (format === undefined ? result : format(result))),
    approval,
  ])

  return compose(body, { name: config.name ?? 'gate', description: config.description })
}
