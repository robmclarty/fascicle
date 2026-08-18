/**
 * chain: named steps over a growing record.
 *
 * `chain<i>(input_name?)` opens a builder whose threaded value is a record of
 * named outputs rather than a single value. The input type must be stated,
 * either as the type argument or via `.input<t>()` on the freshly opened
 * chain; an unannotated `chain()` defaults to `never` so the omission fails
 * at the `run` call site instead of accepting anything. `.step(name, fn)`
 * runs `fn` over the record and merges its output back in under `name`;
 * `.stage(name, project?)` concludes a phase: it opens a grouping span in
 * the trajectory and, when `project` is given, replaces the record with the
 * projection so earlier bindings go out of scope; `.output(fn)` closes the
 * builder and returns an ordinary `Step<i, o>`.
 *
 * Each `.step` entry is a regular `step(name, fn)` whose input happens to be
 * the record, so anything true of steps (spans, error paths, abort checks
 * between entries) is true of chain entries, and the binding name doubles as
 * the entry's id in trajectories. A binding whose whole job is to invoke an
 * arm is `.step(name, arm, select)`: the chain projects the record through
 * `select`, dispatches the arm via `ctx.call`, and records it as the
 * binding's child, so what `describe` renders and what runs cannot diverge.
 * The escape hatch for bodies that need code around the call is
 * `.step(name, fn, { arm })`: the body does its own `ctx.call` and the arm
 * is metadata only, recorded for `describe` but never dispatched.
 *
 * Builder values are immutable: every method returns a new chain, so a
 * prefix can be shared and extended in different directions safely.
 */

import { is_step } from './is_step.js'
import { dispatch_step, register_traced_kind, throw_if_aborted } from './runner.js'
import { step } from './step.js'
import type { AnyStep, RunContext, Step } from './types.js'

let chain_counter = 0

/**
 * Generate a unique step id of the form `chain_<n>`.
 */
function next_chain_id(): string {
  chain_counter += 1
  return `chain_${chain_counter}`
}

type merge<a, b> = { readonly [k in keyof (a & b)]: (a & b)[k] }

export type ChainStepOptions = {
  readonly arm?: AnyStep
}

export type Chain<i, acc> = {
  readonly step: {
    <k extends string, o>(
      name: k,
      fn: (s: acc, ctx: RunContext) => Promise<o> | o,
      options?: ChainStepOptions,
    ): Chain<i, merge<acc, { readonly [p in k]: o }>>
    <k extends string, a, o>(
      name: k,
      arm: Step<a, o>,
      select: (s: acc) => a,
    ): Chain<i, merge<acc, { readonly [p in k]: o }>>
  }
  readonly stage: {
    (name: string): Chain<i, acc>
    <next extends Record<string, unknown>>(
      name: string,
      project: (s: acc, ctx: RunContext) => Promise<next> | next,
    ): Chain<i, merge<next, unknown>>
  }
  readonly output: <o>(fn: (s: acc, ctx: RunContext) => Promise<o> | o) => Step<i, o>
}

/**
 * A freshly opened chain: `Chain` plus `.input<t>()`, which restates the
 * input type once with the binding name already fixed, so
 * `chain('q').input<Request>()` equals `chain<Request, 'q'>('q')`. The first
 * `.step` or `.stage` returns plain `Chain`, so refinement is only possible
 * before any entry is recorded.
 */
export type ChainOpen<i, k extends string, acc> = Chain<i, acc> & {
  readonly input: <t>() => Chain<t, { readonly [p in k]: t }>
}

type LooseFn = (s: Record<string, unknown>, ctx: RunContext) => unknown

type LooseSelect = (s: Record<string, unknown>) => unknown

type ChainEntry =
  | { readonly kind: 'step'; readonly name: string; readonly node: Step<Record<string, unknown>, unknown> }
  | { readonly kind: 'stage'; readonly name: string; readonly project?: LooseFn }

type LooseChain = {
  readonly step: (
    name: string,
    fn_or_arm: LooseFn | AnyStep,
    options_or_select?: ChainStepOptions | LooseSelect,
  ) => LooseChain
  readonly stage: (name: string, project?: LooseFn) => LooseChain
  readonly output: (fn: LooseFn) => Step<unknown, unknown>
}

/**
 * Assemble the runnable chain Step from its entries and output node.
 *
 * Runs entries in order over a record seeded with the input under
 * `input_name`. Step entries merge their output under their name; stage
 * entries end the previous stage span, open a new one that subsequent
 * entries nest under, and, when projecting, replace the record. The output
 * node runs last and its value is the chain's output. `config.plan` lists
 * the entry names in order so `describe` shows the topology without running.
 *
 * The `Step<unknown, unknown>` return is the concrete type, not an erased
 * top type: the run function genuinely accepts any input, seeding the record
 * with whatever arrives. The typed `chain` surface narrows it at the cast.
 */
function build_chain(
  input_name: string,
  entries: ReadonlyArray<ChainEntry>,
  output_node: Step<Record<string, unknown>, unknown>,
): Step<unknown, unknown> {
  const id = next_chain_id()
  const plan = [
    ...entries.map((e) => (e.kind === 'stage' ? `stage:${e.name}` : e.name)),
    'output',
  ]
  const children = [
    ...entries.flatMap((e) => (e.kind === 'step' ? [e.node] : [])),
    output_node,
  ]

  const run_fn = async (input: unknown, ctx: RunContext): Promise<unknown> => {
    let record: Record<string, unknown> = { [input_name]: input }
    let current_ctx = ctx
    let stage_span: string | undefined
    let stage_id: string | undefined

    const end_stage = (error?: string): void => {
      if (stage_span === undefined) return
      const meta: Record<string, unknown> = { id: stage_id }
      if (error !== undefined) meta['error'] = error
      ctx.trajectory.end_span(stage_span, meta)
      stage_span = undefined
    }

    try {
      for (const entry of entries) {
        throw_if_aborted(current_ctx)
        if (entry.kind === 'stage') {
          end_stage()
          stage_id = `stage:${entry.name}`
          const meta: Record<string, unknown> = { id: stage_id }
          if (ctx.parent_span_id !== undefined) meta['parent_span_id'] = ctx.parent_span_id
          stage_span = ctx.trajectory.start_span(entry.name, meta)
          current_ctx = { ...ctx, parent_span_id: stage_span }
          if (entry.project !== undefined) {
            // The typed surface constrains projections to return a record; the
            // runtime trusts that the same way `use` trusts its callback.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            record = (await entry.project(record, current_ctx)) as Record<string, unknown>
          }
        } else {
          const value = await dispatch_step(entry.node, record, current_ctx)
          record = { ...record, [entry.name]: value }
        }
      }
      throw_if_aborted(current_ctx)
      const out = await dispatch_step(output_node, record, current_ctx)
      end_stage()
      return out
    } catch (err) {
      end_stage(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  return {
    id,
    kind: 'chain',
    children,
    config: { input: input_name, plan },
    run: run_fn,
  }
}

/**
 * Build the binding node for the arm-first `.step(name, arm, select)` form.
 *
 * The chain owns the dispatch: the synthesized body projects the record
 * through `select` and hands the result to the arm via `ctx.call`, and the
 * same arm is recorded as the binding's child, so the subtree `describe`
 * renders and the step that runs are one value by construction.
 */
function arm_node(
  name: string,
  arm: AnyStep,
  select: ChainStepOptions | LooseSelect | undefined,
): Step<Record<string, unknown>, unknown> {
  if (typeof select !== 'function') {
    throw new TypeError('chain.step(name, arm, select): select must be a function')
  }
  const base = step(name, (s: Record<string, unknown>, ctx: RunContext) =>
    // The typed surface pairs select's projection with the arm's input, a
    // pairing the erased AnyStep cannot carry, so the call re-asserts it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    ctx.call(arm, select(s) as never),
  )
  return { ...base, children: [arm] }
}

/**
 * Build the binding node for the body form `.step(name, fn, { arm? })`.
 */
function body_node(
  name: string,
  fn: LooseFn,
  options: ChainStepOptions | LooseSelect | undefined,
): Step<Record<string, unknown>, unknown> {
  const base = step(name, fn)
  const arm = typeof options === 'function' ? undefined : options?.arm
  // The arm is describe metadata only: recorded as the binding's child so
  // the subtree renders, never dispatched (the body's ctx.call runs it).
  return arm === undefined ? base : { ...base, children: [arm] }
}

/**
 * Internal untyped builder behind `chain`.
 *
 * `bound` holds the binding names of the current stage segment so duplicate
 * names fail at build time (the typed surface would silently intersect
 * them); a projecting stage resets it because the projection's keys are only
 * known to the type system.
 */
function make_chain(
  input_name: string,
  entries: ReadonlyArray<ChainEntry>,
  bound: ReadonlySet<string>,
): LooseChain {
  return {
    step: (name, fn_or_arm, options_or_select) => {
      if (bound.has(name)) {
        throw new TypeError(
          `chain.step: binding '${name}' is already defined in this stage; names are single-assignment`,
        )
      }
      const node = is_step(fn_or_arm)
        ? arm_node(name, fn_or_arm, options_or_select)
        : body_node(name, fn_or_arm, options_or_select)
      return make_chain(
        input_name,
        [...entries, { kind: 'step', name, node }],
        new Set([...bound, name]),
      )
    },
    stage: (name, project) =>
      make_chain(
        input_name,
        [
          ...entries,
          project === undefined ? { kind: 'stage', name } : { kind: 'stage', name, project },
        ],
        project === undefined ? bound : new Set(),
      ),
    output: (fn) => build_chain(input_name, entries, step('output', fn)),
  }
}

/**
 * Open a chain builder whose record starts as `{ [input_name]: input }`.
 *
 * `input_name` defaults to `'input'`. The input type defaults to `never`, so
 * a chain that never states it produces a `Step<never, o>` that no real
 * input satisfies at `run`; state it as the type argument or, when the
 * binding is renamed, once via `.input<t>()` on the fresh builder. Each
 * `.step` narrows subsequent callbacks to the record accumulated so far, and
 * `.stage` with a projection re-types the record to the projection's
 * return, so binding names and views are checked at compile time with no
 * declared state shape.
 */
export function chain<i = never, k extends string = 'input'>(
  input_name?: k,
): ChainOpen<i, k, { readonly [p in k]: i }> {
  const name = input_name ?? 'input'
  const open = make_chain(name, [], new Set([name]))
  // `.input` is compile-time refinement over the same empty builder, so
  // returning it unchanged is the whole implementation.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { ...open, input: () => open } as unknown as ChainOpen<i, k, { readonly [p in k]: i }>
}

register_traced_kind('chain')
