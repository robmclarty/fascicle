import { describe, expect, it } from 'vitest'
import * as wire from '@a2a-js/sdk'
import type { Task } from '@a2a-js/sdk'
import { data_part, text_part } from '../parts.js'
import {
  default_failure,
  failure_message,
  default_question,
  gate_of,
  is_terminal,
  status_event,
  status_for,
  status_of,
} from '../task_status.js'
import type { Rest, StatusHooks } from '../task_status.js'

const IDS = { task_id: 'task-1', context_id: 'ctx-1' } as const
const STATE = wire.TaskState

const hooks: StatusHooks = {
  gates: (gate) => (gate === 'ci' ? 'external' : 'client'),
  to_question: default_question,
  to_failure: default_failure,
}

function task_in(state: wire.TaskState, metadata?: Record<string, unknown>): Task {
  return {
    id: 'task-1',
    contextId: 'ctx-1',
    status: {
      state,
      message: {
        messageId: 'm1',
        contextId: 'ctx-1',
        taskId: 'task-1',
        role: wire.Role.ROLE_AGENT,
        parts: [],
        metadata,
        extensions: [],
        referenceTaskIds: [],
      },
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    artifacts: [],
    history: [],
    metadata: undefined,
  }
}

const rest_status = (rest: Rest, with_hooks: StatusHooks = hooks) => status_for(wire, with_hooks, IDS, rest)

describe('the defaults', () => {
  it('asks with a line that names the gate, then the payload as data when the gate raised one', () => {
    expect(default_question('approve', { input: 'draft' })).toEqual([
      text_part('Waiting for input at "approve".'),
      data_part({ input: 'draft' }),
    ])
    expect(default_question('approve', undefined)).toEqual([text_part('Waiting for input at "approve".')])
    expect(default_question('approve', null)).toHaveLength(2)
  })

  it('says only that the task failed, whatever the error was', () => {
    const to_failure: StatusHooks['to_failure'] = default_failure
    expect(to_failure(new Error('postgres://admin:hunter2@db.internal refused the connection'))).toBe(
      'The agent could not finish the task.',
    )
    expect(to_failure('a bare string')).toBe('The agent could not finish the task.')
  })

  it('reads a failure as the error message, or the thrown value as text, with failure_message', () => {
    expect(failure_message(new Error('boom'))).toBe('boom')
    expect(failure_message('a bare string')).toBe('a bare string')
    expect(failure_message(42)).toBe('42')
  })
})

describe('is_terminal', () => {
  it('holds for the four states nothing moves a task from, and for no other', () => {
    const terminal = [STATE.TASK_STATE_COMPLETED, STATE.TASK_STATE_FAILED, STATE.TASK_STATE_CANCELED, STATE.TASK_STATE_REJECTED]
    const live = [
      STATE.TASK_STATE_SUBMITTED,
      STATE.TASK_STATE_WORKING,
      STATE.TASK_STATE_INPUT_REQUIRED,
      STATE.TASK_STATE_AUTH_REQUIRED,
      STATE.TASK_STATE_UNSPECIFIED,
    ]
    for (const state of terminal) expect(is_terminal(wire, task_in(state))).toBe(true)
    for (const state of live) expect(is_terminal(wire, task_in(state))).toBe(false)
    expect(is_terminal(wire, { ...task_in(STATE.TASK_STATE_COMPLETED), status: undefined })).toBe(false)
  })
})

describe('gate_of', () => {
  it('reads the gate from the status message metadata, and nothing from anything else', () => {
    expect(gate_of(task_in(STATE.TASK_STATE_INPUT_REQUIRED, { fascicle: { gate: 'approve' } }))).toBe('approve')
    expect(gate_of(task_in(STATE.TASK_STATE_INPUT_REQUIRED, { fascicle: { gate: 7 } }))).toBeUndefined()
    expect(gate_of(task_in(STATE.TASK_STATE_INPUT_REQUIRED, { fascicle: 'approve' }))).toBeUndefined()
    expect(gate_of(task_in(STATE.TASK_STATE_INPUT_REQUIRED, { other: { gate: 'approve' } }))).toBeUndefined()
    expect(gate_of(task_in(STATE.TASK_STATE_INPUT_REQUIRED))).toBeUndefined()
    expect(gate_of({ ...task_in(STATE.TASK_STATE_WORKING), status: undefined })).toBeUndefined()
  })
})

describe('status_of and status_event', () => {
  it('stamps a status with the time it was made', () => {
    const before = Date.now()
    const status = status_of(STATE.TASK_STATE_WORKING)
    expect(status.state).toBe(STATE.TASK_STATE_WORKING)
    expect(status.message).toBeUndefined()
    expect(Date.parse(status.timestamp ?? '')).toBeGreaterThanOrEqual(before)
    expect(Date.parse(status.timestamp ?? '')).toBeLessThanOrEqual(Date.now())
  })

  it('wraps a status as a statusUpdate event for its task', () => {
    const status = status_of(STATE.TASK_STATE_WORKING)
    expect(status_event(IDS, status)).toEqual({
      kind: 'statusUpdate',
      data: { taskId: 'task-1', contextId: 'ctx-1', status, metadata: undefined },
    })
  })
})

describe('status_for', () => {
  it('reads a finished run as COMPLETED, with no message', () => {
    const status = rest_status({ kind: 'done', output: 'anything' })
    expect(status?.state).toBe(STATE.TASK_STATE_COMPLETED)
    expect(status?.message).toBeUndefined()
  })

  it('reads a client gate as INPUT_REQUIRED, with the question from the agent and the gate in its metadata', () => {
    const status = rest_status({ kind: 'suspended', id: 'approve', payload: { input: 'draft' } })
    expect(status?.state).toBe(STATE.TASK_STATE_INPUT_REQUIRED)
    expect(status?.message).toMatchObject({
      taskId: 'task-1',
      contextId: 'ctx-1',
      role: wire.Role.ROLE_AGENT,
      parts: [text_part('Waiting for input at "approve".'), data_part({ input: 'draft' })],
      metadata: { fascicle: { gate: 'approve' } },
      extensions: [],
      referenceTaskIds: [],
    })
    expect(status?.message?.messageId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('carries a gate deadline beside the gate, and leaves the key out when the gate set none', () => {
    const timed = rest_status({ kind: 'suspended', id: 'approve', payload: null, deadline_at: 1_700_000_000_000 })
    expect(timed?.message?.metadata).toEqual({ fascicle: { gate: 'approve', deadline_at: 1_700_000_000_000 } })
    const untimed = rest_status({ kind: 'suspended', id: 'approve', payload: null })
    expect(untimed?.message?.metadata).toEqual({ fascicle: { gate: 'approve' } })
  })

  it('takes a question as text or as parts from to_question', () => {
    const as_text = rest_status({ kind: 'suspended', id: 'approve', payload: 1 }, { ...hooks, to_question: (gate, payload) => `${gate}? ${String(payload)}` })
    expect(as_text?.message?.parts).toEqual([text_part('approve? 1')])
    const as_parts = rest_status({ kind: 'suspended', id: 'approve', payload: 1 }, { ...hooks, to_question: () => [data_part({ ask: true })] })
    expect(as_parts?.message?.parts).toEqual([data_part({ ask: true })])
  })

  it('reads an external gate as WORKING, with a note that names the gate and never asks to_question', () => {
    let asked = false
    const status = rest_status(
      { kind: 'suspended', id: 'ci', payload: { secret: true }, deadline_at: 5 },
      {
        ...hooks,
        to_question: () => {
          asked = true
          return 'never'
        },
      },
    )
    expect(status?.state).toBe(STATE.TASK_STATE_WORKING)
    expect(status?.message?.parts).toEqual([text_part('Waiting on "ci", which this agent\'s clients don\'t answer.')])
    expect(status?.message?.metadata).toEqual({ fascicle: { gate: 'ci', deadline_at: 5 } })
    expect(asked).toBe(false)
  })

  it('reads a refused answer as INPUT_REQUIRED again, with each issue and the path it sits at', () => {
    const status = rest_status({
      kind: 'refused',
      gate: 'approve',
      issues: [{ message: 'Expected boolean', path: ['answer', 0, 'approved'] }, { message: 'Too short' }, { message: 'Odd', path: [] }],
    })
    expect(status?.state).toBe(STATE.TASK_STATE_INPUT_REQUIRED)
    expect(status?.message?.parts).toEqual([
      text_part('The answer to "approve" was refused: answer.0.approved: Expected boolean; Too short; Odd'),
    ])
    expect(status?.message?.metadata).toEqual({ fascicle: { gate: 'approve' } })
  })

  it('reads a failure as FAILED with what to_failure says, and a cancel as CANCELED', () => {
    const failed = rest_status({ kind: 'failed', error: new Error('boom') })
    expect(failed?.state).toBe(STATE.TASK_STATE_FAILED)
    expect(failed?.message?.parts).toEqual([text_part('The agent could not finish the task.')])
    expect(failed?.message?.metadata).toBeUndefined()

    const told = rest_status({ kind: 'failed', error: new Error('boom') }, { ...hooks, to_failure: failure_message })
    expect(told?.message?.parts).toEqual([text_part('boom')])

    const hidden = rest_status({ kind: 'failed', error: new Error('boom') }, { ...hooks, to_failure: () => 'hidden' })
    expect(hidden?.message?.parts).toEqual([text_part('hidden')])

    const canceled = rest_status({ kind: 'canceled' })
    expect(canceled?.state).toBe(STATE.TASK_STATE_CANCELED)
    expect(canceled?.message?.parts).toEqual([text_part('The task was canceled.')])
  })

  it('has no status for a run that is still being driven', () => {
    expect(rest_status({ kind: 'running' })).toBeUndefined()
  })
})
