/**
 * models: the models a session can run on, offered to the client as a
 * config option in the `model` category, which Zed draws as its model
 * picker.
 *
 * ACP v1 has no model field of its own, so the config option is how the
 * protocol carries one. Each model's id is the agent's, and the flow builder
 * reads it from `session.model()`. A model call takes its model as it's
 * built, so the agent builds the session's flow again whenever the user
 * picks another model, and the pick holds from the next turn on. A model may
 * name its own context window, which the context ring is drawn against while
 * the session runs on it.
 */

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { AcpModel } from './types.js'

/** The id of the config option that carries the model. */
export const MODEL_CONFIG_ID = 'model'

/** The models an agent offers and the one each of its sessions starts on. */
export type ModelOffer = {
  readonly models: ReadonlyArray<AcpModel>
  readonly default_model: string
}

/**
 * The models an agent offers, from the config's `models` and
 * `default_model`, or undefined for an agent that offers none. Throws an
 * `Error` that names the problem for a `models` that's empty or lists an id
 * twice, a `default_model` it doesn't list, a `default_model` without
 * `models`, and a flow built once, which can't change its model, so
 * `acp_agent` fails as it's built.
 */
export function model_offer(config: {
  readonly models?: ReadonlyArray<AcpModel> | undefined
  readonly default_model?: string | undefined
  readonly flow: unknown
}): ModelOffer | undefined {
  const { models, default_model } = config
  if (models === undefined) {
    if (default_model === undefined) return undefined
    throw new Error('acp_agent: default_model is set without models; list the models a session can run on, or leave default_model out')
  }
  if (typeof config.flow !== 'function') {
    throw new Error(
      "acp_agent: models needs flow to be a function of the session, since a flow built once can't change its model; build the flow with session.model()",
    )
  }
  const ids = models.map((model) => model.id)
  const [first] = ids
  if (first === undefined) throw new Error('acp_agent: models is empty; list at least one model, or leave models out')
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index)
  if (repeated !== undefined) {
    throw new Error(`acp_agent: models lists ${JSON.stringify(repeated)} twice; give each model its own id`)
  }
  const start = default_model ?? first
  if (!ids.includes(start)) {
    throw new Error(
      `acp_agent: default_model ${JSON.stringify(start)} isn't one of the models (${ids.join(', ')}); add it to models or leave default_model out`,
    )
  }
  return { models, default_model: start }
}

/**
 * Whether the agent offers a model with the id `id`.
 */
export function offers_model(offer: ModelOffer, id: unknown): id is string {
  return offer.models.some((model) => model.id === id)
}

/**
 * The model a session starts on: the one it was stored with when the agent
 * still offers it, and the offer's `default_model` otherwise, or undefined
 * for an agent that offers none.
 */
export function start_model(offer: ModelOffer | undefined, stored: string | undefined): string | undefined {
  if (offer === undefined) return undefined
  return offers_model(offer, stored) ? stored : offer.default_model
}

/**
 * The refusal for a model id the agent doesn't offer, naming the ones it does.
 */
export function unknown_model_message(id: unknown, offer: ModelOffer): string {
  return `unknown model ${JSON.stringify(id)}; choose one of ${offer.models.map((model) => model.id).join(', ')}`
}

/**
 * The session's model as a config option, a select over every model the
 * agent offers, or none for an agent that offers no models.
 */
export function model_options(offer: ModelOffer | undefined, model: string | undefined): SessionConfigOption[] {
  if (offer === undefined || model === undefined) return []
  return [
    {
      id: MODEL_CONFIG_ID,
      name: 'Model',
      description: 'The model that answers the next turn',
      category: 'model',
      type: 'select',
      currentValue: model,
      options: offer.models.map(({ id, name, description }) => ({
        value: id,
        name: name ?? id,
        ...(description === undefined ? {} : { description }),
      })),
    },
  ]
}

/**
 * The context window a session's context ring is drawn against: the
 * window its model names, and the config's `context_window` otherwise.
 */
export function context_window_of(
  config: { readonly models?: ReadonlyArray<AcpModel> | undefined; readonly context_window?: number | undefined },
  model: string | undefined,
): number | undefined {
  return config.models?.find((entry) => entry.id === model)?.context_window ?? config.context_window
}
