/**
 * A synthetic trajectory for the step-14 state treatments: a checkpoint hit,
 * `emit` events mid-step, and a suspension that parks the run.
 *
 * The flow is a plain spine so each treatment reads in isolation: a warm-up
 * step, a checkpointed step the store spares (the lookup hits, so
 * `expensive_brief` never runs and wears the white meta tick), a gathering
 * step that emits progress twice while it works, a suspend gate that parks
 * the run (hollow puck, `SUSPENDED` meta, its card), and a publish step the
 * light never reaches, so the suspended node's outgoing segment stays
 * unbuilt. `TREATMENTS_EMIT_CUT` is the prefix ending on the first emit,
 * the mid-flight moment whose bloom the Playwright study pins.
 *
 * Both the scene unit tests and the Playwright treatments study fold these,
 * so the state the tests pin and the pixels the baselines pin come off one
 * source, the same arrangement as `map-instances.ts`.
 */

const RUN_ID = 'treatments-run'

const T0 = 1_000_000

/** The trajectory prefix length ending on the first emit event. */
export const TREATMENTS_EMIT_CUT = 9

const STRUCTURE = {
  kind: 'sequence',
  id: 'pipeline',
  children: [
    { kind: 'step', id: 'warm_up' },
    {
      kind: 'checkpoint',
      id: 'cache_brief',
      config: { key: 'brief:v1' },
      children: [{ kind: 'step', id: 'expensive_brief' }],
    },
    { kind: 'step', id: 'gather' },
    { kind: 'suspend', id: 'await_approval' },
    { kind: 'step', id: 'publish' },
  ],
}

/** The treatments trajectory, structure line first, run parked suspended. */
export function treatments_trajectory(): ReadonlyArray<Record<string, unknown>> {
  const run_id = RUN_ID
  return [
    { kind: 'flow_structure', structure: STRUCTURE, run_id, ts: T0 },
    { kind: 'span_start', span_id: 'seq', name: 'sequence', id: 'pipeline', run_id, ts: T0 },
    {
      kind: 'span_start',
      span_id: 'warm',
      name: 'step',
      id: 'warm_up',
      parent_span_id: 'seq',
      run_id,
      ts: T0 + 1,
    },
    { kind: 'span_end', span_id: 'warm', id: 'warm_up', run_id, ts: T0 + 13 },
    {
      kind: 'span_start',
      span_id: 'cp',
      name: 'checkpoint',
      id: 'cache_brief',
      parent_span_id: 'seq',
      run_id,
      ts: T0 + 14,
    },
    {
      kind: 'checkpoint',
      status: 'hit',
      key: 'brief:v1',
      id: 'cache_brief',
      span_id: 'cp',
      run_id,
      ts: T0 + 15,
    },
    { kind: 'span_end', span_id: 'cp', id: 'cache_brief', run_id, ts: T0 + 16 },
    {
      kind: 'span_start',
      span_id: 'gath',
      name: 'step',
      id: 'gather',
      parent_span_id: 'seq',
      run_id,
      ts: T0 + 17,
    },
    { kind: 'emit', label: 'progress', pages: 3, run_id, ts: T0 + 40 },
    { kind: 'emit', label: 'progress', pages: 7, run_id, ts: T0 + 58 },
    { kind: 'span_end', span_id: 'gath', id: 'gather', run_id, ts: T0 + 70 },
    {
      kind: 'span_start',
      span_id: 'hold',
      name: 'suspend',
      id: 'await_approval',
      parent_span_id: 'seq',
      run_id,
      ts: T0 + 71,
    },
    {
      kind: 'suspended',
      suspend_id: 'await_approval',
      step_id: 'await_approval',
      run_id,
      ts: T0 + 72,
    },
    {
      kind: 'span_end',
      span_id: 'hold',
      id: 'await_approval',
      error: 'suspended: await_approval',
      error_name: 'suspended_error',
      run_id,
      ts: T0 + 72,
    },
    {
      kind: 'span_end',
      span_id: 'seq',
      id: 'pipeline',
      error: 'suspended: await_approval',
      error_name: 'suspended_error',
      run_id,
      ts: T0 + 73,
    },
    { kind: 'run_end', status: 'suspended', run_id, ts: T0 + 73 },
  ]
}

/** A trajectory prefix as newline-delimited JSON, the wire the server ingests. */
export function treatments_ndjson(count?: number): string {
  const events = treatments_trajectory()
  return `${events
    .slice(0, count ?? events.length)
    .map((event) => JSON.stringify(event))
    .join('\n')}\n`
}
