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
 * both run the same step. Every write to the run's record is conditional on
 * the version the writer read, and a drive writes only over the revision it
 * last saw, so a drive that stalled past its lease can't write over the drive
 * that took the run from it, wherever it stalled. An event that finds the
 * lease taken waits in the run's inbox under its gate's id, and whoever holds
 * the lease takes it up once the run reaches that gate, so the event is
 * queued rather than dropped. And the run records a fingerprint of the flow's
 * shape, so a deploy that changes the flow while a run waits fails loudly
 * instead of replaying different steps against old checkpoints.
 *
 * Everything the driver keeps (the input, resume data, gate payloads, and the
 * output) goes through the store, so it has to survive JSON, the same as any
 * checkpointed value.
 *
 * A run's scope holds its record under `record`, with the inbox inside it,
 * the flow's checkpoints in the `flow` scope, and the lease as the claim on
 * `lease`. Deleting a run clears the whole scope. Keeping the inbox in the
 * record puts every check a delivery makes, and its write, on one version of
 * one key, which is what lets the store's compare-and-set decide every race.
 *
 * A run id can be deleted and started again, so the record carries a `nonce`
 * that `start` draws once for each run it creates. A delivery writes only to
 * the run it first read, and since a store may derive a version from the
 * value's bytes, the nonce is also what keeps the record of a new run apart
 * from the identical-looking record of the run it replaced.
 *
 * A record written before the inbox moved into it is `format: 1`, with its
 * waiting events in an `inbox` scope of their own. The first drive to find
 * one saves it as `format: 2` and marks it `old_inbox`, and from then on a
 * drive that stops at a gate looks in the old scope for that gate's event
 * before it looks in the record. A driver from before this format reads a
 * `format: 2` record as no record at all, so a fleet runs one version of the
 * driver at a time.
 */

import { createHash, randomUUID } from 'node:crypto'
import { is_record } from '#schema'
import { describe } from './describe.js'
import { has_chosen_id } from './node_label.js'
import {
  aborted_error,
  flow_changed_error,
  resume_validation_error,
  run_not_found_error,
} from './errors.js'
import { run, type RunOptions, type RunOutcome } from './runner.js'
import type { CheckpointStore, FlowNode, ScopedCheckpointStore, Step } from './types.js'

type Claims = Required<Pick<CheckpointStore, 'claim' | 'release'>>

type Conditional = Required<Pick<CheckpointStore, 'get_versioned' | 'set_if'>>

/**
 * A store `durable` can keep runs in: one that scopes, and whose scopes can
 * claim and can write on a condition (`get_versioned` and `set_if`).
 * `filesystem_store` from `fascicle/adapters` is one for a single machine and
 * `object_store` is one for a fleet. `checkpoint_store_conformance` in
 * `fascicle/testing` checks a store of your own.
 */
export type DurableStore = {
  readonly scope: (prefix: string) => ScopedCheckpointStore & Claims & Conditional
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

type RunScope = ScopedCheckpointStore & Claims & Conditional

type Suspension = {
  readonly id: string
  readonly payload: unknown
  readonly deadline_at: number | null
}

// The events waiting on gates the run has yet to take up, by gate id.
type Inbox = Readonly<Record<string, { readonly data: unknown }>>

type RunBase = {
  // 2 is what this driver writes. 1 is a record from before the inbox moved
  // into it, which a drive migrates before it does anything else.
  readonly format: 1 | 2
  // Counts the drives' writes. A drive writes only over the revision it last
  // read or wrote, which is what fences off a drive that lost its lease. A
  // delivery changes the inbox and leaves the revision alone, which is how a
  // drive tells a delivery's write from another drive's.
  readonly revision: number
  // Drawn once when `start` creates the run, or '' in a record from a driver
  // that drew none. It tells this run from one deleted and started again
  // under the same id.
  readonly nonce: string
  // The lease owner of the drive that last saved the record, or '' in a
  // record from a driver that kept none. It tells a drive its own landed
  // write from another drive's.
  readonly writer: string
  // True for a run that began as `format: 1`, whose old inbox scope may still
  // hold events for gates it has yet to reach.
  readonly old_inbox: boolean
  readonly input: unknown
  readonly flow: string
  readonly resume_data: Readonly<Record<string, unknown>>
  readonly inbox: Inbox
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
  readonly owner: string
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
 * Read a stored suspension back, or `null` when the value isn't one.
 */
function as_suspension(value: unknown): Suspension | null {
  if (!is_record(value)) return null
  const { id, payload, deadline_at } = value
  if (typeof id !== 'string') return null
  return { id, payload, deadline_at: typeof deadline_at === 'number' ? deadline_at : null }
}

/**
 * Read one inbox entry back, or `undefined` when the value isn't one.
 */
function as_entry(value: unknown): { readonly data: unknown } | undefined {
  return is_record(value) && 'data' in value ? { data: value['data'] } : undefined
}

/**
 * Read a stored inbox back, keeping the entries that hold a datum. A record
 * with no inbox (every `format: 1` record) reads as an empty one.
 */
function as_inbox(value: unknown): Inbox {
  if (!is_record(value)) return {}
  const entries = Object.entries(value).flatMap(([gate_id, stored]) => {
    const entry = as_entry(stored)
    return entry === undefined ? [] : [[gate_id, entry] as const]
  })
  return Object.fromEntries(entries)
}

/**
 * The inbox without the entry for `gate_id`.
 */
function without(inbox: Inbox, gate_id: string): Inbox {
  return Object.fromEntries(Object.entries(inbox).filter(([id]) => id !== gate_id))
}

/**
 * Read a stored run record back, or `undefined` when the value isn't one this
 * driver can read. `start` treats an unreadable record as no record and
 * begins the run again from its input, where its checkpoints still serve.
 */
function as_record(value: unknown): RunRecord | undefined {
  if (!is_record(value)) return undefined
  const { format, revision, input, flow, resume_data, output, error, status } = value
  if (format !== 1 && format !== 2) return undefined
  if (typeof revision !== 'number' || typeof flow !== 'string') return undefined
  if (!is_record(resume_data) || !STATUSES.has(status)) return undefined
  const base: RunBase = {
    format,
    revision,
    nonce: typeof value['nonce'] === 'string' ? value['nonce'] : '',
    writer: typeof value['writer'] === 'string' ? value['writer'] : '',
    old_inbox: value['old_inbox'] === true,
    input,
    flow,
    resume_data,
    inbox: as_inbox(value['inbox']),
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
    // Stryker disable next-line CallExpression: a tick after a loss finds `renew` short-circuit on `lost` and only aborts an aborted controller again, and `end` clears the timer anyway.
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
    owner,
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
 * stored record is still the revision that `next` was built from, and it
 * lands on the version it read that revision at. A drive that lost the
 * lease, or that stalled while another drive moved the run on, finds the
 * revision moved, loses the lease, and leaves the record alone, however late
 * it stalled.
 *
 * The inbox belongs to the deliveries, which write without the lease, so the
 * saved record takes the stored inbox and not the one `next` carries, after
 * `edit` has made the one change this drive means to make to it. A write
 * that conflicts while the revision still matches lost to a delivery (the
 * lease keeps other drives out), so it reads again and writes again with
 * that delivery kept.
 *
 * A store can land a write and still report a conflict, when the answer was
 * lost and a delivery changed the record before the store looked again. So a
 * record one revision on that names this drive as its writer is this save's
 * own write, and it resolves as written, with the delivery in its inbox.
 */
async function save(
  scope: RunScope,
  lease: Lease,
  next: RunRecord,
  edit: (inbox: Inbox) => Inbox = (inbox) => inbox,
): Promise<RunRecord> {
  await lease.confirm()
  for (;;) {
    const read = await scope.get_versioned(RECORD)
    const stored = as_record(read?.value)
    if (stored?.revision === next.revision + 1 && stored.writer === lease.owner) return stored
    if (read === undefined || stored === undefined || stored.revision !== next.revision) {
      throw lease.lose()
    }
    const saved: RunRecord = {
      ...next,
      revision: next.revision + 1,
      writer: lease.owner,
      inbox: edit(stored.inbox),
    }
    if (await scope.set_if(RECORD, saved, read.version)) return saved
  }
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
 * Leave `data` in the inbox of the run that carries `nonce` for `gate_id`,
 * unless a datum already waits there, the run has already passed the gate,
 * or the run is gone.
 *
 * All the checks read one version of the record, and the write lands only
 * on that version, so no claim guards it. A write that conflicts reads the
 * record again and decides again. So of two resumes that race for one gate,
 * the second finds the first one's datum and drops its own, a run that moved
 * past the gate in the meantime drops the datum, and a `delete` in the
 * meantime leaves no record to write to. A run started again under the same
 * id after that `delete` carries another nonce, so the datum never reaches
 * it, however late the delivery wakes up.
 *
 * The record keeps the format it was read with. A `format: 1` record may
 * have events in its old inbox scope, which a drive reads only once it has
 * marked the record `old_inbox`, and a record that claimed to be `format: 2`
 * would skip that step.
 */
async function deliver(scope: RunScope, nonce: string, gate_id: string, data: unknown): Promise<void> {
  for (;;) {
    const read = await scope.get_versioned(RECORD)
    const record = as_record(read?.value)
    if (read === undefined || record === undefined || record.nonce !== nonce) return
    if (Object.hasOwn(record.resume_data, gate_id) || Object.hasOwn(record.inbox, gate_id)) return
    const next: RunRecord = { ...record, inbox: { ...record.inbox, [gate_id]: { data } } }
    if (await scope.set_if(RECORD, next, read.version)) return
  }
}

/**
 * Bring a `format: 1` record up to `format: 2`, marked as a run whose old
 * `inbox` scope may still hold events.
 *
 * A scope can't be listed, so the events stay where they are, and `take_up`
 * reads the old scope one gate at a time, as the run reaches each gate. That
 * way an event for a gate the flow builds inside a step, or for a gate this
 * deploy renamed, is still there when a drive comes looking for it.
 */
function migrate<i, o>(drive: Drive<i, o>, lease: Lease, record: RunRecord): Promise<RunRecord> {
  return save(drive.scope, lease, { ...record, format: 2, old_inbox: true })
}

/**
 * Move the resume data waiting at the run's gate into the run, or resolve
 * `undefined` when none has arrived.
 *
 * The datum leaves the inbox and joins the resume data in one write, so a
 * crash can't leave it in both places or in neither.
 *
 * A run that began as `format: 1` looks in its old inbox scope first. An
 * event that waited there got to the gate before anything in the record's
 * own inbox did, so it wins the gate. Its key is deleted only after the
 * record holds the datum, and after the flow's shape is checked, so neither
 * a crash nor a changed flow can lose it.
 */
async function take_up<i, o>(
  drive: Drive<i, o>,
  lease: Lease,
  record: Waiting,
): Promise<RunRecord | undefined> {
  const gate = record.suspended.id
  const old = drive.scope.scope(INBOX)
  const waited = record.old_inbox ? as_entry(await old.get(gate)) : undefined
  const entry = waited ?? (Object.hasOwn(record.inbox, gate) ? record.inbox[gate] : undefined)
  if (entry === undefined) return undefined
  const current = await check_shape(drive, lease, record)
  const saved = await save(
    drive.scope,
    lease,
    { ...current, status: 'running', resume_data: { ...current.resume_data, [gate]: entry.data } },
    (inbox) => without(inbox, gate),
  )
  if (waited !== undefined) await old.delete(gate)
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
  let record = loaded.format === 1 ? await migrate(drive, lease, loaded) : loaded
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
 * found it taken and left its data in the record's inbox. So once the lease
 * is gone, the call reads the record again and drives once more when
 * something waits at the gate. Another call that took the lease in between
 * gets it first, and this one reports the run busy.
 */
async function bring_to_rest<i, o>(
  drive: Drive<i, o>,
  load: (lease: Lease) => Promise<RunRecord>,
): Promise<DurableOutcome<o>> {
  for (;;) {
    const lease = await take_lease(drive.scope, drive.lease_ms)
    if (lease === undefined) return { kind: 'busy', run_id: drive.run_id }
    let outcome: DurableOutcome<o>
    try {
      outcome = await settle(drive, lease, await load(lease))
    } catch (err) {
      if (lease.lost()) return { kind: 'busy', run_id: drive.run_id }
      throw err
    } finally {
      await lease.end()
    }
    if (outcome.kind !== 'suspended') return outcome
    const record = as_record(await drive.scope.get(RECORD))
    if (record === undefined || !Object.hasOwn(record.inbox, outcome.id)) return outcome
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
 * more. The new record is created only while the key is absent, or on the
 * version of the unreadable record it replaces, so two starts can't both
 * create one, even outside the lease. A start that loses that write drives
 * the record that won. The record is read back before the first drive, so
 * that drive sees the input the way every later one will, after a trip
 * through the store.
 */
async function start_run<i, o>(
  driver: Driver,
  run_id: string,
  flow: Step<i, o>,
  input: i,
  options: DurableRunOptions,
): Promise<DurableOutcome<o>> {
  const drive = drive_for(driver, run_id, flow, options)
  return bring_to_rest(drive, async (lease) => {
    const read = await drive.scope.get_versioned(RECORD)
    const existing = as_record(read?.value)
    if (existing !== undefined) return existing
    const record: RunRecord = {
      format: 2,
      revision: 0,
      nonce: randomUUID(),
      writer: lease.owner,
      old_inbox: false,
      input,
      flow: drive.shape,
      resume_data: {},
      inbox: {},
      output: null,
      // Stryker disable next-line StringLiteral: a run's error is read only once the run has failed, and failing writes it.
      error: '',
      status: 'running',
      suspended: null,
    }
    await drive.scope.set_if(RECORD, record, read?.version ?? null)
    return existing_record(run_id, drive.scope)
  })
}

/**
 * Hand resume data to a run and drive it as far as it goes.
 *
 * Each datum is written to the run's inbox before the lease is taken, so a
 * call that finds the run busy still leaves its data where the holder takes
 * it up. Data for a gate the run has already passed is dropped, because
 * changing it would change the replay, and so is data for a run that's gone,
 * and data for a gate whose inbox already holds some: the first datum to
 * reach a gate is the one it gets. Each datum is checked against one version
 * of the run's record and written only on that version, so the rules hold
 * when two calls race for one gate, and when another call moves the run past
 * the gate or deletes the run at any point before the write, even when the
 * run is started again under the same id. The data go in
 * one after another, since they all write the same record. `undefined`
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
  for (const [id, data] of Object.entries(resume_data)) {
    if (data !== undefined) await deliver(drive.scope, record.nonce, id, data)
  }
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
