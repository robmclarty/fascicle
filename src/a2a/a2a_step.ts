/**
 * a2a_step: a step that hands its input to a remote A2A agent and resolves
 * what the agent's task produced.
 *
 * The step is a leaf that streams text much as a model call does, so it's
 * marked `side_effect`, and under `run.stream` or `record_chunks` the remote
 * agent's text arrives as `model_chunk` events under the step's id.
 *
 * A remote question becomes a local `suspend`, which is what lets agents
 * chain: a Fascicle agent that calls another and gets a question surfaces it
 * as its own, all the way up to whoever runs the outermost flow. When the
 * remote task stops at `INPUT_REQUIRED`, the step suspends the local run at
 * a gate named `<step id>_<round>`, with the remote question as the gate's
 * payload, and a resume hands the answer to the same remote task as its
 * next message. The step builds this from public composites inside its own
 * body. Each round's send runs inside a `checkpoint`, so a replay doesn't
 * send it again, and each gate is a `suspend` that the step calls through
 * `ctx.call`. That needs a checkpoint store, which `durable` gives every
 * drive. Without one a remote question throws `a2a_error`, since a resume
 * would otherwise open a second remote task.
 *
 * The card is read once for each step value, on first use, and the step
 * streams when the card says the agent can and `stream` doesn't say
 * otherwise.
 */

import { createHash } from 'node:crypto'
import type { Artifact, Part } from '@a2a-js/sdk'
import { assert_valid_step_id, checkpoint, step, suspend } from '#core'
import type { AnySchema, RunContext, Step } from '#core'
import { a2a_error } from './errors.js'
import { data_of, data_part, from_plain, text_of, text_part } from './parts.js'
import { send_round } from './remote_task.js'
import type { Outgoing, Remote, Round } from './remote_task.js'
import { load_a2a_client } from './sdk_loader.js'
import type { A2aRequest, A2aResult, A2aStepConfig } from './types.js'

type Question = Extract<Round, { readonly kind: 'question' }>

// A gate's answer is whatever the caller resumes with: the remote agent is
// the one that judges it.
const ANY_ANSWER: AnySchema = {
  '~standard': { version: 1, vendor: 'fascicle', validate: (value) => ({ value }) },
}

/**
 * The parts a request sends: its text, then its data.
 */
function request_parts(input: A2aRequest): Part[] {
  if (typeof input === 'string') return [text_part(input)]
  const parts: Part[] = []
  if (input.text !== undefined) parts.push(text_part(input.text))
  if (input.data !== undefined) parts.push(data_part(input.data))
  return parts
}

/**
 * The parts an answer to a remote question sends: a string as text, and
 * anything else as data.
 */
function answer_parts(answer: unknown): Part[] {
  return typeof answer === 'string' ? [text_part(answer)] : [data_part(answer)]
}

/**
 * The checkpoint key of one round's send. It carries a digest of what the
 * round sends, so a step that runs for several inputs in one run keeps each
 * input's rounds apart.
 */
function round_key(step_id: string, outgoing: Outgoing): string {
  const sent = JSON.stringify([outgoing.task_id ?? '', outgoing.context_id ?? '', outgoing.parts])
  const digest = createHash('sha256').update(sent).digest('hex').slice(0, 16)
  return `a2a_step:${step_id}:${outgoing.round}:${digest}`
}

/**
 * What the step resolves for a completed round.
 */
function result_of(round: Extract<Round, { readonly kind: 'completed' }>): A2aResult {
  // `send_round` wrote these artifacts through `to_plain`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const artifacts = from_plain(round.artifacts) as Artifact[]
  const parts = artifacts.flatMap((artifact) => artifact.parts)
  return {
    task_id: round.task_id,
    context_id: round.context_id,
    text: text_of(parts),
    data: data_of(parts),
    artifacts,
  }
}

/**
 * Reach the remote agent: read its card, and build a client that sends the
 * config's headers with every request, the card's included.
 */
async function connect(config: A2aStepConfig): Promise<Remote> {
  const sdk = await load_a2a_client()
  const fetch_with_headers: typeof fetch = async (input, init) => {
    const extra = typeof config.headers === 'function' ? await config.headers() : (config.headers ?? {})
    const headers = new Headers(init?.headers)
    for (const [name, value] of Object.entries(extra)) headers.set(name, value)
    return fetch(input, { ...init, headers })
  }
  const factory = new sdk.client.ClientFactory({
    transports: [new sdk.client.JsonRpcTransportFactory({ fetchImpl: fetch_with_headers })],
    cardResolver: new sdk.client.DefaultAgentCardResolver({ fetchImpl: fetch_with_headers }),
  })
  const client = await factory.createFromUrl(config.url)
  const card = await client.getAgentCard()
  return { sdk, client, streams: config.stream ?? card.capabilities?.streaming === true }
}

/**
 * Build a step that sends its input to the A2A agent at `config.url` as one
 * message and resolves the task's artifacts.
 *
 * A string input is the message's text. An object's `text` and `data`
 * become a text part and a data part, and its `context_id` continues a
 * conversation with the remote agent. A task that ends failed, rejected,
 * canceled, or waiting for credentials throws `a2a_error` with the state
 * and the status text, and an abort cancels the remote task before the step
 * throws.
 */
export function a2a_step(config: A2aStepConfig): Step<A2aRequest, A2aResult> {
  assert_valid_step_id(config.id, 'a2a_step id', 'put the label in name')
  const step_id = config.id
  let remote: Promise<Remote> | undefined

  // One connection for the step value, made on first use. A failed one is
  // forgotten, so the next run tries again.
  const reach = (): Promise<Remote> => {
    remote ??= connect(config).catch((err: unknown) => {
      remote = undefined
      throw err
    })
    return remote
  }

  const send = checkpoint(
    step(`${step_id}_send`, async (outgoing: Outgoing, ctx: RunContext) => send_round(await reach(), step_id, outgoing, ctx)),
    { key: (outgoing) => round_key(step_id, outgoing), name: `${step_id} send` },
  )

  const gates = new Map<number, Step<Question, unknown>>()
  const gate_for = (round: number): Step<Question, unknown> => {
    const built =
      gates.get(round) ??
      suspend<Question, unknown, unknown>({
        id: `${step_id}_${round}`,
        name: `${step_id} question ${round}`,
        on: () => {},
        resume_schema: ANY_ANSWER,
        combine: (_question, answer) => answer,
      })
    gates.set(round, built)
    return built
  }

  const ask = async (input: A2aRequest, ctx: RunContext): Promise<A2aResult> => {
    let outgoing: Outgoing = {
      round: 1,
      parts: request_parts(input),
      context_id: typeof input === 'string' ? undefined : input.context_id,
    }
    for (;;) {
      const round = await ctx.call(send, outgoing)
      if (round.kind === 'completed') return result_of(round)
      if (ctx.checkpoint_store === undefined) {
        throw new a2a_error(
          `the remote agent asked a question (${JSON.stringify(round.text)}) and step "${step_id}" has no checkpoint store to wait with: drive the flow with durable(), or pass checkpoint_store to run()`,
          { state: 'TASK_STATE_INPUT_REQUIRED', status_text: round.text, task_id: round.task_id },
        )
      }
      const answer = await ctx.call(gate_for(outgoing.round), round)
      outgoing = {
        round: outgoing.round + 1,
        parts: answer_parts(answer),
        task_id: round.task_id,
        context_id: round.context_id,
      }
    }
  }

  const inner = step(step_id, ask, {
    side_effect: true,
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.description === undefined ? {} : { description: config.description }),
  })
  return { ...inner, config: Object.freeze({ remote: 'a2a', url: config.url }) }
}
