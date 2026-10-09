/**
 * durable: drive a flow that suspends across processes, one event at a time.
 *
 * `run.until_suspended` hands back a `resume` closure, and a closure dies
 * with its process. An app that resumes runs from events (a webhook, a
 * finished job, a deadline timer) needs the run to live in a store instead:
 * its input, the resume data its gates consumed, and where it stopped.
 * `durable({ store })` keeps exactly that under one scope per run id, and it
 * drives the flow again from the input whenever an event lands, so replay and
 * checkpoints behave the way they always do.
 *
 * Three things every event-driven app would otherwise write for itself, and
 * usually get wrong, are built in. A lease (a claim on the run's scope that
 * the driver renews while it drives) keeps two invocations from driving one
 * run at once, so a CI webhook and a deadline timer that land together can't
 * both run the same step, and the record's revision fences every write, so a
 * drive that stalled past its lease can't write over the drive that took the
 * run from it. An event that finds the lease taken waits in the run's inbox
 * under its gate's id, and whoever holds the lease takes it up once the run
 * reaches that gate, so the event is queued rather than dropped. And the run
 * records a fingerprint of the flow's shape, so a deploy that changes the
 * flow while a run waits fails loudly instead of replaying different steps
 * against old checkpoints.
 *
 * Everything the driver keeps (the input, resume data, gate payloads, and the
 * output) goes through the store, so it has to survive JSON, the same as any
 * checkpointed value.
 *
 * A run's scope holds its record under `record`, the events waiting on gates
 * in the `inbox` scope, the flow's checkpoints in the `flow` scope, and the
 * lease as the claim on `lease`. Deleting a run clears the whole scope.
 */

import { createHash, randomUUID } from 'node:crypto'
import { describe } from './describe.js'
import { has_chosen_id } from './diagram.js'
import {
  aborted_error,
  flow_changed_error,
  resume_validation_error,
  run_not_found_error,
} from './errors.js'
import { run, type RunOptions, type RunOutcome } from './runner.js'
import type { CheckpointStore, FlowNode, ScopedCheckpointStore, Step } from './types.js'

type Claims = Required<Pick<CheckpointStore, 'claim' | 'release'>>

/**
 * A store `durable` can keep runs in: one that scopes, and whose scopes can
 * claim. `filesystem_store` from `fascicle/adapters` is one, and
 * `checkpoint_store_conformance` in `fascicle/testing` checks a store of
 * your own.
 */
export type DurableStore = {
  readonly scope: (prefix: string) => ScopedCheckpointStore & Claims
}

export type DurableConfig = {
  readonly store: DurableStore
  /**
   * How long a drive owns its run before another invocation may take it
   * over, in milliseconds. The driver renews the lease every third of this
   * while it drives, so the lease only runs out once a drive stops answering
   * (its process died, or stalled for longer than this). Default 60 seconds.
   */
  readonly lease_ms?: number
  /**
   * What happens when a run's flow no longer has the shape the run started
   * on. `'fail'` (the default) throws `flow_changed_error`. `'replay'` takes
   * the new shape, records a `flow_changed` event, and drives on.
   */
  readonly on_flow_change?: 'fail' | 'replay'
}

/**
 * The `run` options a drive passes through. The driver owns the checkpoint
 * store and the resume data, so it leaves those two out.
 */
export type DurableRunOptions = Omit<RunOptions, 'checkpoint_store' | 'resume_data'>

export type DurableOutcome<o> =
  | { readonly kind: 'done'; readonly run_id: string; readonly output: o }
  | {
      readonly kind: 'suspended'
      readonly run_id: string
      readonly id: string
      readonly payload: unknown
      // When the gate's deadline passes, in epoch milliseconds, present when
      // the gate set one. Its clock started when the run stopped at the gate.
      readonly deadline_at?: number
    }
  // Another invocation holds the run. Resume data this call brought waits in
  // the run's inbox, where the holder takes it up, or, should the holder die
  // first, the next call on the run does.
  | { readonly kind: 'busy'; readonly run_id: string }

export type DurableRunState =
  | Exclude<DurableOutcome<unknown>, { readonly kind: 'busy' }>
  // A drive is under way, or one died partway and the next event drives the
  // run again.
  | { readonly kind: 'running'; readonly run_id: string }
  // The last drive threw, with this message. The next event drives the run
  // again.
  | { readonly kind: 'failed'; readonly run_id: string; readonly error: string }

export type DurableRuns = {
  readonly start: <i, o>(
    run_id: string,
    flow: Step<i, o>,
    input: i,
    options?: DurableRunOptions,
  ) => Promise<DurableOutcome<o>>
  readonly resume: <i, o>(
    run_id: string,
    flow: Step<i, o>,
    resume_data: Readonly<Record<string, unknown>>,
    options?: DurableRunOptions,
  ) => Promise<DurableOutcome<o>>
  readonly get: (run_id: string) => Promise<DurableRunState | undefined>
  readonly delete: (run_id: string) => Promise<boolean>
}

type RunScope = ScopedCheckpointStore & Claims

type Suspension = {
  readonly id: string
  readonly payload: unknown
  readonly deadline_at: number | null
}

type RunBase = {
  readonly format: 1
  // Counts the record's writes. A drive writes only over the revision it last
  // read or wrote, which is what fences off a drive that lost its lease.
  readonly revision: number
  readonly input: unknown
  readonly flow: string
  readonly resume_data: Readonly<Record<string, unknown>>
  readonly output: unknown
  readonly error: string
}

// `suspended` is the gate the run waits at while it's suspended, and the last
// gate it waited at otherwise, which is what a refused resume puts back.
type RunRecord = RunBase &
  (
    | { readonly status: 'running' | 'done' | 'failed'; readonly suspended: Suspension | null }
    | { readonly status: 'suspended'; readonly suspended: Suspension }
  )

type Waiting = Extract<RunRecord, { readonly status: 'suspended' }>

type Lease = {
  readonly signal: AbortSignal
  readonly lost: () => boolean
  // Mark the lease lost and abort the drive, returning the abort's reason.
  readonly lose: () => aborted_error
  // Renew now and throw once another drive holds the lease.
  readonly confirm: () => Promise<void>
  readonly end: () => Promise<void>
}

type Drive<i, o> = {
  readonly run_id: string
  readonly scope: RunScope
  readonly flow: Step<i, o>
  readonly shape: string
  readonly options: DurableRunOptions
  readonly lease_ms: number
  readonly on_flow_change: 'fail' | 'replay'
}

type Driver = {
  readonly store: DurableStore
  readonly lease_ms: number
  readonly on_flow_change: 'fail' | 'replay'
}

const RECORD = 'record'
const LEASE = 'lease'
const INBOX = 'inbox'
const FLOW = 'flow'
const DEFAULT_LEASE_MS = 60_000
const STATUSES: ReadonlySet<unknown> = new Set(['running', 'suspended', 'done', 'failed'])

/**
 * A short digest of the flow's shape: each node's kind, the id its author
 * chose, and how the nodes nest. Generated ids stay out, since they shift with
 * build order, and so do names, descriptions, and config. Rewording a step or
 * editing a prompt leaves the digest alone, while adding, removing, moving,
 * or renaming a step changes it.
 */
function fingerprint<i, o>(flow: Step<i, o>): string {
  const shape = JSON.stringify(shape_of(describe.json(flow)))
  return createHash('sha256').update(shape).digest('hex').slice(0, 16)
}

/**
 * One node of the shape that `fingerprint` digests.
 */
function shape_of(node: FlowNode): unknown {
  return [node.kind, has_chosen_id(node) ? node.id : null, (node.children ?? []).map(shape_of)]
}

/**
 * True for a plain object, the only shape a stored record or entry takes.
 */
function is_object(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a stored suspension back, or `null` when the value isn't one.
 */
function as_suspension(value: unknown): Suspension | null {
  if (!is_object(value)) return null
  const { id, payload, deadline_at } = value
  if (typeof id !== 'string') return null
  return { id, payload, deadline_at: typeof deadline_at === 'number' ? deadline_at : null }
}

/**
 * Read a stored run record back, or `undefined` when the value isn't one this
 * driver wrote. `start` treats an unreadable record as no record and begins
 * the run again from its input, where its checkpoints still serve.
 */
function as_record(value: unknown): RunRecord | undefined {
  if (!is_object(value) || value['format'] !== 1) return undefined
  const { revision, input, flow, resume_data, output, error, status } = value
  if (typeof revision !== 'number' || typeof flow !== 'string') return undefined
  if (!is_object(resume_data) || !STATUSES.has(status)) return undefined
  const base: RunBase = {
    format: 1,
    revision,
    input,
    flow,
    resume_data,
    output,
    error: typeof error === 'string' ? error : '',
  }
  const suspended = as_suspension(value['suspended'])
  if (status !== 'suspended') {
    // STATUSES holds only the four statuses, and this one isn't 'suspended'.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return { ...base, status: status as 'running' | 'done' | 'failed', suspended }
  }
  return suspended === null ? undefined : { ...base, status, suspended }
}

/**
 * The outcome a finished run reports to the call that drove it.
 */
function done_view<i, o>(drive: Drive<i, o>, record: RunRecord): DurableOutcome<o> {
  // The driver stored this output from a run of the same flow.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { kind: 'done', run_id: drive.run_id, output: record.output as o }
}

/**
 * The outcome a run waiting at `gate` reports.
 */
function suspended_view(
  run_id: string,
  gate: Suspension,
): Extract<DurableOutcome<never>, { readonly kind: 'suspended' }> {
  return {
    kind: 'suspended',
    run_id,
    id: gate.id,
    payload: gate.payload,
    ...(gate.deadline_at === null ? {} : { deadline_at: gate.deadline_at }),
  }
}

/**
 * What `get` reports for a stored run.
 */
function state_of(run_id: string, record: RunRecord): DurableRunState {
  if (record.status === 'suspended') return suspended_view(run_id, record.suspended)
  if (record.status === 'done') return { kind: 'done', run_id, output: record.output }
  if (record.status === 'failed') return { kind: 'failed', run_id, error: record.error }
  return { kind: 'running', run_id }
}

/**
 * Take the run's lease for a fresh owner and renew it every third of
 * `lease_ms` until `end`.
 *
 * A renewal that finds another owner holding the lease marks it lost, stops
 * renewing, and aborts the drive through `signal`, so a drive that outlived
 * its lease stops instead of running a step twice. Loss is final: a lost
 * lease never renews again, even once the key is free. A renewal that throws
 * is retried on the next tick. `end` waits out the renewals still in flight
 * before it releases, so a late one can't take the lease back afterwards.
 */
async function take_lease(scope: RunScope, lease_ms: number): Promise<Lease | undefined> {
  const owner = randomUUID()
  if (!(await scope.claim(LEASE, owner, lease_ms))) return undefined
  const controller = new AbortController()
  let lost = false
  let renewals: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setInterval> | undefined
  const lose = (): aborted_error => {
    lost = true
    clearInterval(timer)
    const err = new aborted_error('another drive took over this run')
    controller.abort(err)
    return err
  }
  const renew = async (): Promise<boolean> => !lost && (await scope.claim(LEASE, owner, lease_ms))
  timer = setInterval(() => {
    renewals = renewals.then(renew).then(
      (held) => {
        if (!held) lose()
      },
      () => {},
    )
  }, lease_ms / 3)
  timer.unref()
  return {
    signal: controller.signal,
    lost: () => lost,
    lose,
    confirm: async () => {
      if (!(await renew())) throw lose()
    },
    end: async () => {
      clearInterval(timer)
      await renewals
      await scope.release(LEASE, owner)
    },
  }
}

/**
 * Write the run's record and resolve the record as written.
 *
 * The write goes through only while this drive holds the lease and the
 * stored record is still the revision that `next` was built from. A drive
 * that lost the lease, or that stalled while another drive moved the run on,
 * finds the revision moved, loses the lease, and leaves the record alone.
 */
async function save(scope: RunScope, lease: Lease, next: RunRecord): Promise<RunRecord> {
  await lease.confirm()
  const stored = as_record(await scope.get(RECORD))
  if (stored === undefined || stored.revision !== next.revision) throw lease.lose()
  const saved: RunRecord = { ...next, revision: next.revision + 1 }
  await scope.set(RECORD, saved)
  return saved
}

/**
 * Hold a run to the flow shape it started on. A run on the same shape passes
 * through. A changed shape throws `flow_changed_error`, unless the driver
 * replays, in which case the run records a `flow_changed` event and adopts
 * the new shape.
 */
async function check_shape<i, o>(
  drive: Drive<i, o>,
  lease: Lease,
  record: RunRecord,
): Promise<RunRecord> {
  if (record.flow === drive.shape) return record
  if (drive.on_flow_change === 'fail') {
    throw new flow_changed_error(drive.run_id, record.flow, drive.shape)
  }
  drive.options.trajectory?.record({
    kind: 'flow_changed',
    run_id: drive.run_id,
    started_on: record.flow,
    continued_on: drive.shape,
    ts: Date.now(),
  })
  return save(drive.scope, lease, { ...record, flow: drive.shape })
}

/**
 * The resume data waiting in the run's inbox for `gate_id`, if any arrived.
 */
async function read_inbox(
  scope: RunScope,
  gate_id: string,
): Promise<{ readonly data: unknown } | undefined> {
  const entry = await scope.scope(INBOX).get(gate_id)
  return is_object(entry) && 'data' in entry ? { data: entry['data'] } : undefined
}

/**
 * Move the resume data waiting at the run's gate into the run, or resolve
 * `undefined` when none has arrived.
 *
 * The record is saved before the inbox entry is deleted, so a crash between
 * the two leaves the data in one place or the other and never in neither.
 */
async function take_up<i, o>(
  drive: Drive<i, o>,
  lease: Lease,
  record: Waiting,
): Promise<RunRecord | undefined> {
  const gate = record.suspended.id
  const entry = await read_inbox(drive.scope, gate)
  if (entry === undefined) return undefined
  const current = await check_shape(drive, lease, record)
  const saved = await save(drive.scope, lease, {
    ...current,
    status: 'running',
    resume_data: { ...current.resume_data, [gate]: entry.data },
  })
  await drive.scope.scope(INBOX).delete(gate)
  return saved
}

/**
 * The record after a drive came to rest: done with its output, or waiting at
 * a gate with that gate's deadline, if it has one, counted from now.
 */
function after_outcome<o>(record: RunRecord, outcome: RunOutcome<o>): RunRecord {
  if (outcome.kind === 'done') {
    return { ...record, status: 'done', output: outcome.output, suspended: null }
  }
  const deadline_at = outcome.deadline_ms === undefined ? null : Date.now() + outcome.deadline_ms
  const gate: Suspension = { id: outcome.id, payload: outcome.payload, deadline_at }
  return { ...record, status: 'suspended', suspended: gate }
}

/**
 * The record after a drive threw. A resume the gate refused is dropped, and
 * the run goes back to waiting at that gate, so one bad event can't wedge the
 * run. Anything else marks the run failed until the next event drives it
 * again.
 */
function after_failure(record: RunRecord, err: unknown): RunRecord {
  const gate = record.suspended
  if (err instanceof resume_validation_error && gate !== null && err.suspend_id === gate.id) {
    const resume_data = Object.fromEntries(
      Object.entries(record.resume_data).filter(([id]) => id !== gate.id),
    )
    return { ...record, status: 'suspended', suspended: gate, resume_data }
  }
  return { ...record, status: 'failed', error: err instanceof Error ? err.message : String(err) }
}

/**
 * Run the flow from its input with every resume datum taken up so far, then
 * save where it came to rest. The run's abort signal fires when the lease is
 * lost, as well as when the caller's own signal does.
 *
 * A drive that throws surfaces its own error even when the store then fails
 * to save the failure. The record stays as it was in that case, and the next
 * event drives the run again, the way it would after a crash.
 */
async function drive_once<i, o>(
  drive: Drive<i, o>,
  lease: Lease,
  stored: RunRecord,
): Promise<RunRecord> {
  const record = await check_shape(drive, lease, stored)
  const caller_abort = drive.options.abort
  let outcome: RunOutcome<o>
  try {
    // The driver stored this input when the run started on the same flow.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    outcome = await run.until_suspended(drive.flow, record.input as i, {
      ...drive.options,
      abort: caller_abort === undefined ? lease.signal : AbortSignal.any([caller_abort, lease.signal]),
      checkpoint_store: drive.scope.scope(FLOW),
      resume_data: record.resume_data,
    })
  } catch (err) {
    // A lost lease fails the save's own check, so a drive that lost its run
    // writes nothing here.
    await save(drive.scope, lease, after_failure(record, err)).catch(() => {})
    throw err
  }
  return save(drive.scope, lease, after_outcome(record, outcome))
}

/**
 * Drive the run until it's done or waiting at a gate with nothing in its
 * inbox for that gate.
 */
async function settle<i, o>(
  drive: Drive<i, o>,
  lease: Lease,
  loaded: RunRecord,
): Promise<DurableOutcome<o>> {
  let record = loaded
  for (;;) {
    if (record.status === 'done') return done_view(drive, record)
    if (record.status === 'suspended') {
      const resumed = await take_up(drive, lease, record)
      if (resumed === undefined) return suspended_view(drive.run_id, record.suspended)
      record = resumed
    }
    record = await drive_once(drive, lease, record)
  }
}

/**
 * Take the lease, bring the run to rest, and let the lease go.
 *
 * An event that landed for the run's gate while this call held the lease
 * found it taken and left its data in the inbox. So once the lease is gone,
 * the call looks again and drives once more when something waits at the gate.
 * Another call that took the lease in between gets it first, and this one
 * reports the run busy.
 */
async function bring_to_rest<i, o>(
  drive: Drive<i, o>,
  load: () => Promise<RunRecord>,
): Promise<DurableOutcome<o>> {
  for (;;) {
    const lease = await take_lease(drive.scope, drive.lease_ms)
    if (lease === undefined) return { kind: 'busy', run_id: drive.run_id }
    let outcome: DurableOutcome<o>
    try {
      outcome = await settle(drive, lease, await load())
    } catch (err) {
      if (lease.lost()) return { kind: 'busy', run_id: drive.run_id }
      throw err
    } finally {
      await lease.end()
    }
    if (outcome.kind !== 'suspended') return outcome
    if ((await read_inbox(drive.scope, outcome.id)) === undefined) return outcome
  }
}

/**
 * The scope that holds `run_id`, which has to be a non-empty string.
 */
function scope_for(driver: Driver, run_id: string): RunScope {
  if (run_id.length === 0) throw new TypeError('durable: a run id must be a non-empty string')
  return driver.store.scope(run_id)
}

/**
 * The record of a run that has to exist, or `run_not_found_error`.
 */
async function existing_record(run_id: string, scope: RunScope): Promise<RunRecord> {
  const record = as_record(await scope.get(RECORD))
  if (record === undefined) throw new run_not_found_error(run_id)
  return record
}

/**
 * Collect what one call drives with.
 */
function drive_for<i, o>(
  driver: Driver,
  run_id: string,
  flow: Step<i, o>,
  options: DurableRunOptions,
): Drive<i, o> {
  return {
    run_id,
    scope: scope_for(driver, run_id),
    flow,
    shape: fingerprint(flow),
    options,
    lease_ms: driver.lease_ms,
    on_flow_change: driver.on_flow_change,
  }
}

/**
 * Start a run, or pick it up where it is when it already exists. A repeated
 * start (a webhook delivered twice) neither restarts the run nor changes its
 * input, though it does drive a run that failed, or whose drive died, once
 * more. The new record is read back before the first drive, so that drive
 * sees the input the way every later one will, after a trip through the
 * store.
 */
async function start_run<i, o>(
  driver: Driver,
  run_id: string,
  flow: Step<i, o>,
  input: i,
  options: DurableRunOptions,
): Promise<DurableOutcome<o>> {
  const drive = drive_for(driver, run_id, flow, options)
  return bring_to_rest(drive, async () => {
    const existing = as_record(await drive.scope.get(RECORD))
    if (existing !== undefined) return existing
    const record: RunRecord = {
      format: 1,
      revision: 0,
      input,
      flow: drive.shape,
      resume_data: {},
      output: null,
      // Stryker disable next-line StringLiteral: a run's error is read only once the run has failed, and failing writes it.
      error: '',
      status: 'running',
      suspended: null,
    }
    await drive.scope.set(RECORD, record)
    return existing_record(run_id, drive.scope)
  })
}

/**
 * Hand resume data to a run and drive it as far as it goes.
 *
 * Each datum is written to the run's inbox before the lease is taken, so a
 * call that finds the run busy still leaves its data where the holder takes
 * it up. Data for a gate the run already passed is dropped, because changing
 * it would change the replay, and so is data for a gate whose inbox already
 * holds some: the first datum to reach a gate is the one it gets. `undefined`
 * resumes nothing. A call with no new data still drives a run that failed,
 * or whose drive died, once more.
 */
async function resume_run<i, o>(
  driver: Driver,
  run_id: string,
  flow: Step<i, o>,
  resume_data: Readonly<Record<string, unknown>>,
  options: DurableRunOptions,
): Promise<DurableOutcome<o>> {
  const drive = drive_for(driver, run_id, flow, options)
  const record = await existing_record(run_id, drive.scope)
  if (record.status === 'done') return done_view(drive, record)
  const fresh = Object.entries(resume_data).filter(
    ([id, data]) => data !== undefined && !Object.hasOwn(record.resume_data, id),
  )
  const inbox = drive.scope.scope(INBOX)
  await Promise.all(
    fresh.map(async ([id, data]) => {
      if ((await read_inbox(drive.scope, id)) === undefined) await inbox.set(id, { data })
    }),
  )
  return bring_to_rest(drive, () => existing_record(run_id, drive.scope))
}

/**
 * Delete everything a run keeps, unless a drive holds it right now.
 */
async function delete_run(driver: Driver, run_id: string): Promise<boolean> {
  const scope = scope_for(driver, run_id)
  if (!(await scope.claim(LEASE, randomUUID(), driver.lease_ms))) return false
  await scope.clear()
  return true
}

/**
 * Keep the runs of flows that suspend in `config.store`, and drive them one
 * event at a time.
 *
 * `start(run_id, flow, input)` begins a run and drives it until it's done or
 * waiting at a gate. `resume(run_id, flow, { [gate]: data })` hands a run
 * the data its gate waits for and drives it on. Both report `busy` instead
 * when another invocation is driving the run, and both are safe to repeat.
 * `get(run_id)` reads where a run stands without driving it, and
 * `delete(run_id)` removes it, resolving false while a drive holds it.
 */
export function durable(config: DurableConfig): DurableRuns {
  const lease_ms = config.lease_ms ?? DEFAULT_LEASE_MS
  if (!Number.isFinite(lease_ms) || lease_ms <= 0) {
    throw new RangeError(`durable: lease_ms must be a positive number of milliseconds, got ${lease_ms}`)
  }
  const driver: Driver = {
    store: config.store,
    lease_ms,
    on_flow_change: config.on_flow_change ?? 'fail',
  }
  return {
    start: (run_id, flow, input, options = {}) => start_run(driver, run_id, flow, input, options),
    resume: (run_id, flow, resume_data, options = {}) =>
      resume_run(driver, run_id, flow, resume_data, options),
    get: async (run_id) => {
      const record = as_record(await scope_for(driver, run_id).get(RECORD))
      return record === undefined ? undefined : state_of(run_id, record)
    },
    delete: (run_id) => delete_run(driver, run_id),
  }
}
