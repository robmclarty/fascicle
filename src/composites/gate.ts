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
 *   ask for approval of a result that the store never kept.
 * - A resume serves the stored result or fails the run: it never runs
 *   `inner`, since a new result would pass through an approval that covered
 *   the old one. A store that fails the read, or no longer holds the result,
 *   fails the resume with `gate_result_error`. A failed read on a first run
 *   is still a miss, since nobody has approved anything yet. A hand-built
 *   checkpoint before a `suspend` that shows its result can't tell a first
 *   run from a resume, so it should pass `'fail'` for both `on_write_error`
 *   and `on_read_error`.
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
 *   `checkpoint_store`. With neither, the gate still suspends, but its resume
 *   fails with `gate_result_error`, since nothing holds the result it
 *   showed. Present, the gate-local store wins over the run-level one,
 *   because an explicit argument beats ambient configuration.
 * - One run reaches a gate once per input: a second reach on another input,
 *   for the next item of a `map` or a later round of a `loop`, throws
 *   `duplicate_suspend_id_error` with `reason: 'reached_twice'` before it
 *   reads or writes the store, since the key is fixed per gate and the one
 *   stored result and the one decision answer the first input. A `retry`
 *   that reaches the gate again on the same input passes.
 * - The suspend's `on` hook is a noop: notification is the driver's job, and
 *   `run.until_suspended` already hands it the payload to render.
 */

import {
  assert_valid_step_id,
  checkpoint,
  compose,
  duplicate_suspend_id_error,
  gate_result_error,
  same_input_as,
  scope,
  stash,
  step,
  suspend,
  use,
} from '#core'
import type { CheckpointStore, RunContext, Step } from '#core'
import { name_parts } from './parts.js'

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
 * Whether the gate `id` is resuming: its id holds a defined value of its own
 * in the run's resume data, which is exactly when its `suspend` passes. Only
 * an own value counts, so a gate named like an `Object.prototype` member
 * never mistakes the inherited member for a decision.
 */
function is_resuming(ctx: RunContext, id: string): boolean {
  const resume_data = ctx.resume_data
  return resume_data !== undefined && Object.hasOwn(resume_data, id) && resume_data[id] !== undefined
}

/**
 * A store that holds `value` and nothing else, so the checkpoint's own run
 * serves it as a hit. A hit never writes, so the writes go nowhere.
 */
function holding(value: unknown): CheckpointStore {
  return {
    get: async () => value,
    set: async () => {},
    delete: async () => {},
  }
}

/**
 * The gate's checkpoint, with a run that checks the gate's input and serves
 * a resumed gate from the store or fails the run.
 *
 * Before it reads or writes the store, on a first run as well as a resume,
 * the run checks its input: the first reach in a run keeps a test of its
 * input for that run, which the run's cleanup drops, and a later reach on
 * another input throws `duplicate_suspend_id_error` with
 * `reason: 'reached_twice'`. The key is fixed per gate, so a second input
 * would read or overwrite the first one's result, and the gate's `suspend`,
 * which always sees a view of that one result, can't tell.
 *
 * A gate that isn't resuming runs the checkpoint as built. A resumed one
 * reads the store itself, so it never runs `inner`: with no store, it throws
 * `gate_result_error` with `reason: 'no_store'` and records nothing; a read
 * that throws records the checkpoint's `read_error` event and throws
 * `reason: 'read_error'`; and a miss records `miss` and throws
 * `reason: 'missing'`. A hit goes to the checkpoint's own run over a store
 * that holds only that value, so the checkpoint records the hit and marks
 * the gates inside `inner` reached, as a hit always has. The node keeps its
 * kind, id, children, and config, so `describe` and a durable run's
 * fingerprint see the checkpoint they always have.
 */
function resume_aware<i, o>(checkpointed: Step<i, o>, id: string, key: string): Step<i, o> {
  const first_inputs = new Map<string, (input: unknown) => boolean>()
  const run_fn = async (input: i, ctx: RunContext): Promise<o> => {
    const same = first_inputs.get(ctx.run_id)
    if (same === undefined) {
      first_inputs.set(ctx.run_id, same_input_as(input))
      // Stryker disable next-line BlockStatement,CallExpression: a run id is never used again, so a note left behind changes no later run, and dropping it only keeps the map from growing.
      ctx.on_cleanup(() => {
        // Stryker disable next-line CallExpression: the same drop, as the run ends.
        first_inputs.delete(ctx.run_id)
      })
    } else if (!same(input)) {
      throw new duplicate_suspend_id_error(id, 'reached_twice')
    }
    if (!is_resuming(ctx, id)) return checkpointed.run(input, ctx)
    const store = ctx.checkpoint_store
    if (store === undefined) throw new gate_result_error(id, 'no_store')
    const meta = { id: checkpointed.id, key, span_id: ctx.parent_span_id }
    let value: unknown
    try {
      value = await store.get(key)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      ctx.trajectory.record({ kind: 'checkpoint', status: 'read_error', error, ...meta })
      throw new gate_result_error(id, 'read_error', err)
    }
    if (value === null || value === undefined) {
      ctx.trajectory.record({ kind: 'checkpoint', status: 'miss', ...meta })
      throw new gate_result_error(id, 'missing')
    }
    return checkpointed.run(input, { ...ctx, checkpoint_store: holding(value) })
  }
  return { ...checkpointed, run: run_fn }
}

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
 * On resume (any defined resume value) the gate resolves to the stored inner
 * result unchanged; the decision itself is discarded. A resume that can't
 * serve the stored result throws `gate_result_error` rather than run `inner`
 * again. On a re-run against the same store, the checkpoint absorbs the
 * replay so `inner` never re-executes.
 * Throws at construction time when `inner` is anonymous, because the cached
 * result must map back to a stable step, and when `config.id` isn't an
 * identifier, which it checks under its own name before its `suspend` sees
 * the id.
 *
 * Implemented as a `compose`d `scope`: the checkpointed result is stashed,
 * projected into the approver's view, and handed to `suspend`; the suspend's
 * `combine` returns a `use` step that restores the stashed result, which is
 * how the decision stays signal-only. The checkpoint keeps its node and runs
 * through `resume_aware`, which is how a resume never runs `inner`.
 */
export function gate<i, o>(inner: Step<i, o>, config: GateConfig<o>): Step<i, o> {
  if (inner.anonymous === true) {
    throw new Error(
      "gate requires a named inner step, got anonymous — give the inner step an id with step('id', fn)",
    )
  }
  const { id, store, format } = config
  assert_valid_step_id(id, 'gate id', 'put the label in name')

  const key = `gate:${id}`
  const checkpointed = resume_aware(checkpoint(inner, { key, on_write_error: 'fail' }), id, key)
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

  return compose(body, {
    name: config.name ?? 'gate',
    description: config.description,
    parts: name_parts([
      [inner.id, inner],
      [id, approval],
    ]),
  })
}
