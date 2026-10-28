import { describe, expect, it } from 'vitest'
import {
  aborted_error,
  duplicate_suspend_id_error,
  flow_changed_error,
  gate_result_error,
  resume_validation_error,
  run_not_found_error,
  suspended_error,
  timeout_error,
} from '../errors.js'

describe('typed errors', () => {
  it('timeout_error carries the declared kind and timeout_ms', () => {
    const err = new timeout_error('too slow', 250)
    expect(err).toBeInstanceOf(Error)
    expect(err.kind).toBe('timeout_error')
    expect(err.name).toBe('timeout_error')
    expect(err.timeout_ms).toBe(250)
    expect(err.message).toBe('too slow')
  })

  it('suspended_error defaults its message from the suspend id', () => {
    const err = new suspended_error('approval', { step: 'ship' })
    expect(err.kind).toBe('suspended_error')
    expect(err.suspend_id).toBe('approval')
    expect(err.payload).toEqual({ step: 'ship' })
    expect(err.message).toBe('suspended at approval')
  })

  it('suspended_error accepts an explicit message override', () => {
    const err = new suspended_error('approval', null, 'needs human')
    expect(err.message).toBe('needs human')
  })

  it('resume_validation_error preserves its issues payload', () => {
    const issues = [{ message: 'bad', path: ['foo'] }]
    const err = new resume_validation_error('bad resume', issues)
    expect(err.kind).toBe('resume_validation_error')
    expect(err.issues).toBe(issues)
    expect(err.suspend_id).toBeUndefined()
  })

  it('resume_validation_error names the gate whose resume data failed', () => {
    const err = new resume_validation_error('bad resume', [], 'approve')
    expect(err.suspend_id).toBe('approve')
    expect(err.name).toBe('resume_validation_error')
  })

  it('names suspended_error after its class', () => {
    expect(new suspended_error('gate', null).name).toBe('suspended_error')
  })

  it('flow_changed_error carries both fingerprints and says what to do', () => {
    const err = new flow_changed_error('pr-7', 'aaaa', 'bbbb')
    expect(err).toBeInstanceOf(Error)
    expect(err.kind).toBe('flow_changed_error')
    expect(err.name).toBe('flow_changed_error')
    expect(err.run_id).toBe('pr-7')
    expect(err.started_on).toBe('aaaa')
    expect(err.continued_on).toBe('bbbb')
    expect(err.message).toBe(
      "durable run pr-7 started on a flow of another shape (aaaa, now bbbb): finish it on the flow it started with, delete it, or drive it with on_flow_change: 'replay'",
    )
  })

  it('gate_result_error names the gate, the reason, and what to do when the store failed the read', () => {
    const failure = new Error('disk unavailable')
    const err = new gate_result_error('approve', 'read_error', failure)
    expect(err).toBeInstanceOf(Error)
    expect(err.kind).toBe('gate_result_error')
    expect(err.name).toBe('gate_result_error')
    expect(err.suspend_id).toBe('approve')
    expect(err.reason).toBe('read_error')
    expect(err.cause).toBe(failure)
    expect(err.message).toBe(
      'gate approve resumed, and its store failed to read the result that it showed (disk unavailable): resume the run again once the store reads, since the approval is still in its resume data',
    )
  })

  it('gate_result_error carries a store failure that is not an Error as its text', () => {
    const err = new gate_result_error('approve', 'read_error', 'quota exceeded')
    expect(err.cause).toBe('quota exceeded')
    expect(err.message).toContain('(quota exceeded)')
  })

  it('gate_result_error says to start again when the store no longer holds the result', () => {
    const err = new gate_result_error('approve', 'missing')
    expect(err.reason).toBe('missing')
    expect('cause' in err).toBe(false)
    expect(err.message).toBe(
      'gate approve resumed, and its store no longer holds the result that it showed: delete the run and start it again',
    )
  })

  it('gate_result_error says how to give a gate with no store one', () => {
    const err = new gate_result_error('approve', 'no_store')
    expect(err.reason).toBe('no_store')
    expect('cause' in err).toBe(false)
    expect(err.message).toBe(
      'gate approve resumed with no store to serve the result that it showed: give the gate a store or the run a checkpoint_store, or use a plain suspend when the step is cheap and deterministic',
    )
  })

  it('duplicate_suspend_id_error names each place, as the walk labels it, and says what to do', () => {
    const paths = [
      ['sequence_1', 'approve'],
      ['sequence_1', 'approve'],
    ]
    const err = new duplicate_suspend_id_error('approve', 'declared_twice', {
      paths,
      labels: ['sequence_1 > approve (step 1)', 'sequence_1 > approve (step 3)'],
      at_branch: false,
    })
    expect(err).toBeInstanceOf(Error)
    expect(err.kind).toBe('duplicate_suspend_id_error')
    expect(err.name).toBe('duplicate_suspend_id_error')
    expect(err.suspend_id).toBe('approve')
    expect(err.reason).toBe('declared_twice')
    expect(err.paths).toBe(paths)
    expect(err.message).toBe(
      'suspend id "approve" is used in 2 places (sequence_1 > approve (step 1), sequence_1 > approve (step 3)): resume data is keyed by id, so give each suspend and gate an id of its own',
    )
  })

  it('duplicate_suspend_id_error names each place by its path when it has no labels, and adds the branch advice', () => {
    const err = new duplicate_suspend_id_error('approve', 'declared_twice', {
      paths: [
        ['branch_1', 'approve'],
        ['branch_1', 'sequence_2', 'approve'],
      ],
      at_branch: true,
    })
    expect(err.message).toBe(
      "suspend id \"approve\" is used in 2 places (branch_1 > approve, branch_1 > sequence_2 > approve): resume data is keyed by id, so give each suspend and gate an id of its own; only one arm of a branch runs, but a resume replays its condition, so each arm's gate needs an id of its own",
    )
  })

  it('duplicate_suspend_id_error says a suspend takes one decision per run when it was reached twice', () => {
    const err = new duplicate_suspend_id_error('approve', 'reached_twice')
    expect(err.reason).toBe('reached_twice')
    expect(err.paths).toEqual([])
    expect(err.message).toBe(
      "suspend approve was reached again in this run with another input, and its resume data answered the first one: a suspend takes one decision per run, so approve a map's batch at a gate before the map, or a loop's result at a gate after it",
    )
  })

  it('run_not_found_error names the run', () => {
    const err = new run_not_found_error('pr-7')
    expect(err.kind).toBe('run_not_found_error')
    expect(err.name).toBe('run_not_found_error')
    expect(err.run_id).toBe('pr-7')
    expect(err.message).toBe('no durable run pr-7: start it before resuming it')
  })

  it('suspended_error carries the gate deadline, and none by default', () => {
    expect(new suspended_error('ci', null, undefined, 3_600_000).deadline_ms).toBe(3_600_000)
    expect(new suspended_error('ci', null).deadline_ms).toBeUndefined()
  })

  it('aborted_error defaults to message "aborted" with no reason', () => {
    const err = new aborted_error()
    expect(err.kind).toBe('aborted_error')
    expect(err.message).toBe('aborted')
    expect(err.reason).toBeUndefined()
  })

  it('aborted_error carries the provided reason', () => {
    const err = new aborted_error('received SIGINT', { reason: { signal: 'SIGINT' } })
    expect(err.reason).toEqual({ signal: 'SIGINT' })
  })

  it('aborted_error accepts engine metadata (step_index, tool_call_in_flight)', () => {
    const err = new aborted_error('aborted', {
      reason: 'abort',
      step_index: 3,
      tool_call_in_flight: { id: 't-1', name: 'search' },
    })
    expect(err.step_index).toBe(3)
    expect(err.tool_call_in_flight).toEqual({ id: 't-1', name: 'search' })
  })

  it('aborted_error leaves step_index undefined when not supplied (core-origin aborts)', () => {
    expect(new aborted_error().step_index).toBeUndefined()
    expect(new aborted_error('received SIGINT', { reason: { signal: 'SIGINT' } }).step_index)
      .toBeUndefined()
  })

  it('aborted_error preserves an explicit step_index of 0 (engine-origin)', () => {
    const err = new aborted_error('aborted', { step_index: 0 })
    expect(err.step_index).toBe(0)
  })
})
