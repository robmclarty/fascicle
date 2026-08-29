/**
 * Synthetic map-instance trajectories for the artboard-03 tick studies.
 *
 * A map over `count` items, wrapped in a sequence with a trailing step so the
 * mapped node stays a plain map child (not the terminus) and wears the instance
 * meta. `failed` names the instance indices that end in error; `live` leaves
 * that many trailing instances open, the mid-flight state whose alive window
 * glows. With `live` at zero the run completes: the map closes, the trailing
 * step runs, and `run_end` settles it.
 *
 * Both the scene unit tests and the Playwright tick study fold these, so the
 * geometry the tests pin and the pixels the baseline pins come off one source.
 * The events are the same permissive wire shape the viewer already parses; no
 * producer change rides here.
 */

export type MapScaleSpec = {
  /** How many instances the map dispatches. */
  readonly count: number
  /** Instance indices (0-based, in dispatch order) that end in error. */
  readonly failed?: ReadonlyArray<number>
  /** Trailing instances left open, the alive window of a mid-flight run. */
  readonly live?: number
  readonly run_id?: string
  readonly t0?: number
}

const CHILD_ID = 'summarize'

/** One instance's wall duration; the group span reads as a real number of ms. */
const INSTANCE_MS = 10

/** The trajectory events for a map at the given scale, structure line first. */
export function map_trajectory(spec: MapScaleSpec): ReadonlyArray<Record<string, unknown>> {
  const { count, failed = [], live = 0, run_id = 'ticks-run', t0 = 1_000_000 } = spec
  const failing = new Set(failed)
  const ended = count - live
  const structure = {
    kind: 'sequence',
    id: 'seq',
    children: [
      {
        kind: 'map',
        id: 'map_1',
        config: { items: { kind: '<fn>', name: 'items' }, concurrency: 8 },
        children: [{ kind: 'step', id: CHILD_ID }],
      },
      { kind: 'step', id: 'finalize' },
    ],
  }

  const events: Record<string, unknown>[] = [
    { kind: 'flow_structure', structure, run_id, ts: t0 },
    { kind: 'span_start', span_id: 'seq', name: 'sequence', id: 'seq', run_id, ts: t0 },
    {
      kind: 'span_start',
      span_id: 'map',
      name: 'map',
      id: 'map_1',
      parent_span_id: 'seq',
      run_id,
      ts: t0 + 1,
    },
  ]
  for (let index = 0; index < count; index += 1) {
    events.push({
      kind: 'span_start',
      span_id: `inst-${index}`,
      name: 'step',
      id: CHILD_ID,
      parent_span_id: 'map',
      run_id,
      ts: t0 + 2 + index,
    })
  }
  for (let index = 0; index < ended; index += 1) {
    events.push({
      kind: 'span_end',
      span_id: `inst-${index}`,
      id: CHILD_ID,
      run_id,
      ts: t0 + 2 + index + INSTANCE_MS,
      ...(failing.has(index) ? { error: 'instance failed', error_name: 'Error' } : {}),
    })
  }
  if (live === 0) {
    const settle = t0 + 2 + count + INSTANCE_MS
    events.push({ kind: 'span_end', span_id: 'map', id: 'map_1', run_id, ts: settle })
    events.push({
      kind: 'span_start',
      span_id: 'fin',
      name: 'step',
      id: 'finalize',
      parent_span_id: 'seq',
      run_id,
      ts: settle,
    })
    events.push({ kind: 'span_end', span_id: 'fin', id: 'finalize', run_id, ts: settle + 5 })
    events.push({ kind: 'span_end', span_id: 'seq', id: 'seq', run_id, ts: settle + 5 })
    events.push({ kind: 'run_end', status: 'done', run_id, ts: settle + 6 })
  }
  return events
}

/** The trajectory as newline-delimited JSON, the wire the server ingests. */
export function map_trajectory_ndjson(spec: MapScaleSpec): string {
  return `${map_trajectory(spec)
    .map((event) => JSON.stringify(event))
    .join('\n')}\n`
}
