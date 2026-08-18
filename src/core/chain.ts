/**
 * chain: named steps over a growing record.
 *
 * `chain<i>(input_name?)` opens a builder whose threaded value is a record of
 * named outputs rather than a single value. `.step(name, fn)` runs `fn` over
 * the record and merges its output back in under `name`; `.stage(name,
 * project?)` concludes a phase: it opens a grouping span in the trajectory
 * and, when `project` is given, replaces the record with the projection so
 * earlier bindings go out of scope; `.output(fn)` closes the builder and
 * returns an ordinary `Step<i, o>`.
 *
 * Each `.step` entry is a regular `step(name, fn)` whose input happens to be
 * the record, so anything true of steps (spans, error paths, abort checks
 * between entries) is true of chain entries, and the binding name doubles as
 * the entry's id in trajectories. Invoking another Step from inside a
 * binding is `ctx.call`, exactly as in a hand-written step body.
 *
 * Builder values are immutable: every method returns a new chain, so a
 * prefix can be shared and extended in different directions safely.
 */

import { dispatch_step, register_traced_kind, throw_if_aborted } from './runner.js'
import { step } from './step.js'
import type { RunContext, Step } from './types.js'

let chain_counter = 0

/**
 * Generate a unique step id of the form `chain_<n>`.
 */
function next_chain_id(): string {
  chain_counter += 1
  return `chain_${chain_counter}`
}

type merge<a, b> = { readonly [k in keyof (a & b)]: (a & b)[k] }

export type Chain<i, acc> = {
  readonly step: <k extends string, o>(
    name: k,
    fn: (s: acc, ctx: RunContext) => Promise<o> | o,
  ) => Chain<i, merge<acc, { readonly [p in k]: o }>>
  readonly stage: {
    (name: string): Chain<i, acc>
    <next extends Record<string, unknown>>(
      name: string,
      project: (s: acc, ctx: RunContext) => Promise<next> | next,
    ): Chain<i, merge<next, unknown>>
  }
  readonly output: <o>(fn: (s: acc, ctx: RunContext) => Promise<o> | o) => Step<i, o>
}

type LooseFn = (s: Record<string, unknown>, ctx: RunContext) => unknown

type ChainEntry =
  | { readonly kind: 'step'; readonly name: string; readonly node: Step<Record<string, unknown>, unknown> }
  | { readonly kind: 'stage'; readonly name: string; readonly project?: LooseFn }

type LooseChain = {
  readonly step: (name: string, fn: LooseFn) => LooseChain
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
    step: (name, fn) => {
      if (bound.has(name)) {
        throw new TypeError(
          `chain.step: binding '${name}' is already defined in this stage; names are single-assignment`,
        )
      }
      const node = step(name, fn)
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
 * `input_name` defaults to `'input'`. The builder is typed: each `.step`
 * narrows subsequent callbacks to the record accumulated so far, and
 * `.stage` with a projection re-types the record to the projection's
 * return, so binding names and views are checked at compile time with no
 * declared state shape.
 */
export function chain<i, k extends string = 'input'>(
  input_name?: k,
): Chain<i, { readonly [p in k]: i }> {
  const name = input_name ?? 'input'
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return make_chain(name, [], new Set([name])) as unknown as Chain<i, { readonly [p in k]: i }>
}

register_traced_kind('chain')
