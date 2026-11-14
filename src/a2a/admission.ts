/**
 * A thin wrapper around the SDK's request handler that refuses a message
 * its task can't take.
 *
 * The SDK appends a message to its task's history before it calls the
 * executor, so a message for a task that's working would be recorded and
 * then go nowhere. This wrapper looks first. A message with no task passes
 * through, and so does one for a task that's missing or terminal, which the
 * SDK refuses in its own words. A message for a live task is admitted only
 * when the task waits at a client gate and nothing in this process holds
 * it, and it takes the task's hold as it's admitted, so a second answer to
 * the same gate finds the task working. Anything else is refused with
 * `UnsupportedOperationError` before the SDK has recorded a thing.
 */

import type { SendMessageRequest } from '@a2a-js/sdk'
import type { A2ARequestHandler, ServerCallContext, TaskStore } from '@a2a-js/sdk/server'
import type { DurableRuns } from '#core'
import type { A2aServerSdk } from './sdk_loader.js'
import { is_terminal } from './task_status.js'
import { take_hold } from './task_runner.js'
import type { Hold, Holds } from './task_runner.js'

export type AdmissionConfig = {
  readonly sdk: A2aServerSdk
  readonly inner: A2ARequestHandler
  readonly store: TaskStore
  readonly runs: DurableRuns
  readonly holds: Holds
  readonly gates: (gate: string) => 'client' | 'external'
}

/**
 * Give back a hold that no drive took, which happens when the SDK refused
 * the message after it was admitted.
 */
function give_back(hold: Hold | undefined): void {
  if (hold !== undefined && !hold.taken) hold.release()
}

/**
 * Wrap `config.inner` so that `SendMessage` and `SendStreamingMessage`
 * refuse a message its task isn't waiting for. Every other method passes
 * straight through.
 */
export function admitting_handler(config: AdmissionConfig): A2ARequestHandler {
  const { sdk, inner, store, runs, holds } = config

  const refuse = (task_id: string, why: string): never => {
    throw new sdk.errors.UnsupportedOperationError(`Task ${task_id} can't take a message: ${why}`)
  }

  // Take the task's hold for a message it can take, or throw. Resolves
  // `undefined` for a message the SDK decides on by itself.
  const admit = async (params: SendMessageRequest, context: ServerCallContext): Promise<Hold | undefined> => {
    const task_id = params.message?.taskId
    if (!task_id) return undefined
    const task = await store.load(task_id, context)
    if (task === undefined || is_terminal(sdk.wire, task)) return undefined
    if (holds.has(task_id)) return refuse(task_id, "it's working, so wait until it asks for input")
    const hold = take_hold(holds, task_id)
    try {
      const run = await runs.get(task_id)
      if (run === undefined) return refuse(task_id, 'it has no run left to resume')
      if (run.kind !== 'suspended') return refuse(task_id, "it's working, so wait until it asks for input")
      if (config.gates(run.id) !== 'client') {
        return refuse(task_id, `it waits on "${run.id}", which this agent's clients don't answer`)
      }
      return hold
    } catch (err) {
      hold.release()
      throw err
    }
  }

  return {
    getAgentCard: () => inner.getAgentCard(),
    getAuthenticatedExtendedAgentCard: (params, context) => inner.getAuthenticatedExtendedAgentCard(params, context),
    sendMessage: async (params, context) => {
      const hold = await admit(params, context)
      try {
        return await inner.sendMessage(params, context)
      } finally {
        give_back(hold)
      }
    },
    sendMessageStream: async function* (params, context) {
      const hold = await admit(params, context)
      try {
        yield* inner.sendMessageStream(params, context)
      } finally {
        give_back(hold)
      }
    },
    getTask: (params, context) => inner.getTask(params, context),
    cancelTask: (params, context) => inner.cancelTask(params, context),
    createTaskPushNotificationConfig: (params, context) => inner.createTaskPushNotificationConfig(params, context),
    getTaskPushNotificationConfig: (params, context) => inner.getTaskPushNotificationConfig(params, context),
    listTaskPushNotificationConfigs: (params, context) => inner.listTaskPushNotificationConfigs(params, context),
    deleteTaskPushNotificationConfig: (params, context) => inner.deleteTaskPushNotificationConfig(params, context),
    resubscribe: (params, context) => inner.resubscribe(params, context),
    listTasks: (params, context) => inner.listTasks(params, context),
  }
}
