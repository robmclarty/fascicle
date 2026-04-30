/**
 * learn: offline self-improvement composer.
 *
 * `learn({ flow, source, analyzer })` reads recorded trajectory events from
 * past runs of `flow`, hands them to a user-supplied `analyzer` step alongside
 * `describe(flow)`, and returns the analyzer's proposals plus summary metadata
 * (events considered, distinct run ids).
 *
 * The amplify example is the *online* counterpart of this pattern: propose →
 * score → accept/reject inside a single run. `learn` is the *offline*
 * counterpart: reflect on what already happened across one or many recorded
 * runs without an evaluator in the loop.
 *
 * Implemented as a `compose`d `scope` of (compute meta) → (build LearnInput) →
 * (analyzer) → (wrap result with meta). No engine dependency; the analyzer
 * decides how to use the events.
 *
 * Three source kinds: `events` (in-memory), `paths` (explicit JSONL files),
 * `dir` (recursive *.jsonl walk). File reads honor `ctx.abort` at file-level
 * granularity; malformed lines are skipped and surface as `learn.parse_error`
 * trajectory events with 1-indexed line offsets. When `max_events` clips the
 * filtered set, a `learn.truncated` event records `available`, `kept`, and the
 * configured cap.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  aborted_error,
  compose,
  describe,
  scope,
  stash,
  step,
  trajectory_event_schema,
  use,
} from '@repo/core'
import type { RunContext, Step, TrajectoryEvent } from '@repo/core'

export type TrajectorySource =
  | { readonly kind: 'events'; readonly events: ReadonlyArray<TrajectoryEvent> }
  | { readonly kind: 'paths'; readonly paths: ReadonlyArray<string> }
  | { readonly kind: 'dir'; readonly dir: string }

export type LearnInput = {
  readonly flow_description: string
  readonly events: ReadonlyArray<TrajectoryEvent>
  readonly prior?: unknown
}

export type Improvement = {
  readonly target: string
  readonly kind: 'prompt' | 'config' | 'structure' | 'note'
  readonly rationale: string
  readonly suggestion: string
}

export type LearnConfig<i extends LearnInput, o> = {
  readonly name?: string
  readonly flow: Step<unknown, unknown>
  readonly source: TrajectorySource
  readonly analyzer: Step<i, o>
  readonly filter?: (event: TrajectoryEvent) => boolean
  readonly max_events?: number
}

export type LearnResult<o> = {
  readonly proposals: o
  readonly events_considered: number
  readonly run_ids: ReadonlyArray<string>
}

const DEFAULT_MAX_EVENTS = 10_000
const META_KEY = '__learn_meta'

type LearnMeta = {
  readonly events_considered: number
  readonly run_ids: ReadonlyArray<string>
}

type MetaPlus = LearnMeta & {
  readonly events: ReadonlyArray<TrajectoryEvent>
  readonly prior: unknown
}

async function walk_jsonl(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walk_jsonl(full)))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full)
    }
  }
  return out
}

async function read_jsonl(file_path: string, ctx: RunContext): Promise<TrajectoryEvent[]> {
  const content = await readFile(file_path, 'utf8')
  const lines = content.split('\n')
  const events: TrajectoryEvent[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    if (raw === undefined || raw.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      ctx.trajectory.record({ kind: 'learn.parse_error', path: file_path, line: i + 1 })
      continue
    }
    const result = trajectory_event_schema.safeParse(parsed)
    if (result.success) {
      events.push(result.data)
    } else {
      ctx.trajectory.record({ kind: 'learn.parse_error', path: file_path, line: i + 1 })
    }
  }
  return events
}

function throw_if_aborted(ctx: RunContext): void {
  if (!ctx.abort.aborted) return
  const reason = ctx.abort.reason
  if (reason instanceof aborted_error) throw reason
  throw new aborted_error('aborted', reason === undefined ? {} : { reason })
}

async function resolve_events(
  source: TrajectorySource,
  ctx: RunContext,
): Promise<ReadonlyArray<TrajectoryEvent>> {
  if (source.kind === 'events') return source.events

  const file_paths =
    source.kind === 'paths' ? [...source.paths] : (await walk_jsonl(source.dir)).toSorted()

  const all: TrajectoryEvent[] = []
  for (const p of file_paths) {
    throw_if_aborted(ctx)
    const events = await read_jsonl(p, ctx)
    all.push(...events)
  }
  return all
}

function collect_run_ids(events: ReadonlyArray<TrajectoryEvent>): ReadonlyArray<string> {
  const seen = new Set<string>()
  const out: string[] = []
  for (const event of events) {
    const id = event['run_id']
    if (typeof id === 'string' && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

export function learn<i extends LearnInput, o>(
  config: LearnConfig<i, o>,
): Step<unknown, LearnResult<o>> {
  const { flow, source, analyzer, filter } = config
  const max = config.max_events ?? DEFAULT_MAX_EVENTS

  const compute_meta = step(
    'learn_compute_meta',
    async (prior: unknown, ctx): Promise<MetaPlus> => {
      const all = await resolve_events(source, ctx)
      const filtered = filter ? all.filter(filter) : all
      const truncated = filtered.length > max
      const capped = truncated ? filtered.slice(0, max) : filtered
      if (truncated) {
        ctx.trajectory.record({
          kind: 'learn.truncated',
          available: filtered.length,
          kept: capped.length,
          max_events: max,
        })
      }
      return {
        events_considered: capped.length,
        run_ids: collect_run_ids(capped),
        events: capped,
        prior,
      }
    },
  )

  const build_input = step(
    'learn_build_input',
    (meta: MetaPlus): LearnInput => ({
      flow_description: describe(flow),
      events: meta.events,
      prior: meta.prior,
    }),
  )

  const wrap_result = use(
    [META_KEY],
    (vars, proposals: o, ctx): LearnResult<o> => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const meta = vars[META_KEY] as LearnMeta
      ctx.trajectory.record({
        kind: 'learn.summary',
        events_considered: meta.events_considered,
        run_ids: meta.run_ids,
      })
      return {
        proposals,
        events_considered: meta.events_considered,
        run_ids: meta.run_ids,
      }
    },
  )

  const inner = scope([
    stash(META_KEY, compute_meta),
    build_input,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    analyzer as unknown as Step<unknown, unknown>,
    wrap_result,
  ])

  return compose(config.name ?? 'learn', inner)
}
