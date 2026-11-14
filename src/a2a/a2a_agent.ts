/**
 * a2a_agent: a flow as an Agent2Agent (A2A) v1.0 agent, with its handlers
 * ready and nothing listening.
 *
 * It loads the SDK, builds the card, and wires an executor over durable
 * runs into the SDK's `DefaultRequestHandler`, which holds the protocol's
 * rules (terminal tasks, history, owner scoping, and error shapes). Two thin
 * layers sit around the SDK's parts: a task store that keeps each record in
 * step with its run (task_records.ts), and a request handler that refuses a
 * message its task isn't waiting for (admission.ts).
 *
 * The agent is logic without process glue, the way `acp_agent` is. `fetch`
 * is a web handler, so the agent runs under `serve_a2a` or under whatever
 * framework a caller already has, and `request_handler` covers the REST and
 * gRPC bindings that this module leaves out. It owns no process, so it
 * leaves the signals alone, and `close` leaves the stores to the caller who
 * opened them.
 */

import type { AgentCard } from '@a2a-js/sdk'
import { memory_store } from '#adapters'
import { describe, durable } from '#core'
import { admitting_handler } from './admission.js'
import { http_handler } from './http.js'
import { output_parts } from './parts.js'
import { load_a2a_server } from './sdk_loader.js'
import { task_records } from './task_records.js'
import { task_runner } from './task_runner.js'
import type { Holds } from './task_runner.js'
import { default_failure, default_question } from './task_status.js'
import type { StatusHooks } from './task_status.js'
import type { A2aAgent, A2aAgentConfig, A2aCard } from './types.js'

const DEFAULT_MODES = ['text/plain', 'application/json']
const DEFAULT_MAX_BODY_BYTES = 1_048_576
const DEFAULT_MAX_DRIVES = 8

/**
 * The SDK's agent card for a config's card: one JSON-RPC interface at the
 * card's URL, streaming on, and push notifications and the extended card off.
 */
function agent_card(card: A2aCard): AgentCard {
  return {
    name: card.name,
    description: card.description,
    supportedInterfaces: [{ url: card.url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
    provider: card.provider === undefined ? undefined : { ...card.provider },
    version: card.version ?? '0.0.0',
    documentationUrl: card.documentation_url,
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: { ...card.security_schemes },
    securityRequirements: [...(card.security_requirements ?? [])],
    defaultInputModes: [...(card.input_modes ?? DEFAULT_MODES)],
    defaultOutputModes: [...(card.output_modes ?? DEFAULT_MODES)],
    skills: card.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: [...(skill.tags ?? [])],
      examples: [...(skill.examples ?? [])],
      inputModes: [...(skill.input_modes ?? [])],
      outputModes: [...(skill.output_modes ?? [])],
      securityRequirements: [],
    })),
    signatures: [],
    iconUrl: card.icon_url,
  }
}

/**
 * Warn on stderr about the steps that every answer to a gate runs again. A
 * resumed drive replays the flow from its input, so a model call before a
 * gate that no `checkpoint` holds bills again each time a client answers.
 */
function warn_about_replays<i, o>(config: A2aAgentConfig<i, o>): void {
  const replays = describe.replays(config.flow)
  if (replays.length === 0) return
  const names = replays.map((hint) => `${hint.id} (before ${hint.gates.join(', ')})`).join('; ')
  process.stderr.write(
    `a2a_agent: ${config.card.name} runs these steps again on every answer to a gate, so wrap each in checkpoint(): ${names}\n`,
  )
}

/**
 * Build an A2A agent over `config.flow`, with its handlers ready and
 * nothing listening.
 *
 * Every task is a durable run in `config.runs`, over `memory_store` when
 * the caller gives none, so a task that outlives the process is a choice of
 * store and not a second code path. Throws `a2a_sdk_missing_error` when the
 * `@a2a-js/sdk` peer isn't installed.
 */
export async function a2a_agent<i, o>(config: A2aAgentConfig<i, o>): Promise<A2aAgent> {
  const sdk = await load_a2a_server()
  const card = agent_card(config.card)
  const runs = config.runs ?? durable({ store: memory_store() })
  const holds: Holds = new Map()
  const custom_parts = config.to_parts
  // The run stored this output from the config's own flow.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const to_parts = custom_parts === undefined ? output_parts : (output: unknown) => custom_parts(output as o)
  const hooks: StatusHooks = {
    gates: config.gates ?? (() => 'client'),
    to_question: config.to_question ?? default_question,
    to_failure: config.to_failure ?? default_failure,
  }
  const records = task_records({
    wire: sdk.wire,
    inner: config.task_store ?? new sdk.server.InMemoryTaskStore(),
    runs,
    hooks,
    to_parts,
    is_live: (task_id) => holds.has(task_id),
  })
  const buses = new sdk.server.DefaultExecutionEventBusManager()
  const runner = task_runner({ sdk, config, runs, records, holds, hooks, to_parts, buses })
  const request_handler = admitting_handler({
    sdk,
    inner: new sdk.server.DefaultRequestHandler(card, records.store, runner.executor, buses),
    store: records.store,
    runs,
    holds,
    gates: hooks.gates,
  })
  const max_drives = config.max_drives ?? DEFAULT_MAX_DRIVES
  let closed = false
  warn_about_replays(config)

  return {
    fetch: http_handler({
      sdk,
      card,
      handler: request_handler,
      authenticate: config.authenticate,
      rpc_path: config.rpc_path ?? '/',
      max_body_bytes: config.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES,
      has_room: () => holds.size < max_drives,
      is_closed: () => closed,
    }),
    resume: runner.resume,
    request_handler,
    card,
    close: async () => {
      closed = true
      await runner.close()
    },
  }
}
