import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { client, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { step } from '#core'
import type { Step, TrajectoryEvent } from '#core'
import { acp_agent } from '../acp_agent.js'
import { context_window_of, model_offer, model_options, start_model } from '../models.js'
import { filesystem_session_store } from '../session_store.js'
import { connect_client, open_session, read_turn } from '../test/connect_client.js'
import type { AcpModel, AcpSession, AcpTurn, ServeAcpConfig } from '../types.js'

const MODELS: ReadonlyArray<AcpModel> = [
  { id: 'sonnet', name: 'Claude Sonnet', description: 'Fast and capable', context_window: 1000 },
  { id: 'gpt' },
]

const scratch_dirs: string[] = []

afterAll(async () => {
  await Promise.all(scratch_dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A fresh directory under the system's temp directory, removed after the suite. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fascicle-acp-models-'))
  scratch_dirs.push(dir)
  return dir
}

const builder = (): Step<string, string> => step('noop', () => '')

describe('model_offer', () => {
  it('offers no models when the config lists none', () => {
    expect(model_offer({ flow: builder })).toBeUndefined()
  })

  it('starts sessions on the first model unless default_model names another', () => {
    expect(model_offer({ models: MODELS, flow: builder })).toEqual({ models: MODELS, default_model: 'sonnet' })
    expect(model_offer({ models: MODELS, default_model: 'gpt', flow: builder })).toEqual({ models: MODELS, default_model: 'gpt' })
  })

  it.each<[string, Parameters<typeof model_offer>[0], string]>([
    [
      'a default_model without models',
      { default_model: 'gpt', flow: builder },
      'acp_agent: default_model is set without models; list the models a session can run on, or leave default_model out',
    ],
    [
      'a flow built once',
      { models: MODELS, flow: step('noop', () => '') },
      "acp_agent: models needs flow to be a function of the session, since a flow built once can't change its model; build the flow with session.model()",
    ],
    ['an empty models', { models: [], flow: builder }, 'acp_agent: models is empty; list at least one model, or leave models out'],
    [
      'a model listed twice',
      { models: [{ id: 'a' }, { id: 'b' }, { id: 'a' }], flow: builder },
      'acp_agent: models lists "a" twice; give each model its own id',
    ],
    [
      'a default_model the models leave out',
      { models: MODELS, default_model: 'opus', flow: builder },
      `acp_agent: default_model "opus" isn't one of the models (sonnet, gpt); add it to models or leave default_model out`,
    ],
  ])('rejects %s', (_, config, message) => {
    expect(() => model_offer(config)).toThrow(message)
  })
})

describe('model_options', () => {
  it("lists every model under its name, or its id when it has none, with the session's model chosen", () => {
    const offer = model_offer({ models: MODELS, flow: builder })
    expect(model_options(offer, 'gpt')).toStrictEqual([
      {
        id: 'model',
        name: 'Model',
        description: 'The model that answers the next turn',
        category: 'model',
        type: 'select',
        currentValue: 'gpt',
        options: [
          { value: 'sonnet', name: 'Claude Sonnet', description: 'Fast and capable' },
          { value: 'gpt', name: 'gpt' },
        ],
      },
    ])
  })

  it('lists nothing for an agent that offers no models', () => {
    expect(model_options(undefined, undefined)).toEqual([])
    expect(model_options(undefined, 'gpt')).toEqual([])
    expect(model_options(model_offer({ models: MODELS, flow: builder }), undefined)).toEqual([])
  })
})

describe('start_model', () => {
  const offer = model_offer({ models: MODELS, flow: builder })

  it('starts a stored session on its model while the agent still offers it, and on the default otherwise', () => {
    expect(start_model(offer, 'gpt')).toBe('gpt')
    expect(start_model(offer, 'retired')).toBe('sonnet')
    expect(start_model(offer, undefined)).toBe('sonnet')
  })

  it('starts on no model for an agent that offers none', () => {
    expect(start_model(undefined, 'gpt')).toBeUndefined()
  })
})

describe('context_window_of', () => {
  it("takes the model's own window over the config's", () => {
    expect(context_window_of({ models: MODELS, context_window: 50 }, 'sonnet')).toBe(1000)
    expect(context_window_of({ models: MODELS, context_window: 50 }, 'gpt')).toBe(50)
    expect(context_window_of({ models: MODELS }, 'gpt')).toBeUndefined()
    expect(context_window_of({ context_window: 50 }, undefined)).toBe(50)
    expect(context_window_of({ models: MODELS, context_window: 50 }, 'retired')).toBe(50)
  })
})

/**
 * An agent offering `MODELS` whose flow answers with the model it was
 * built for, and records each session it's built for with that model.
 */
async function model_agent(overrides: Partial<ServeAcpConfig<AcpTurn, string>> & { throw_for?: string } = {}) {
  const built: Array<{ session: AcpSession; model: string | undefined }> = []
  const { throw_for, ...config } = overrides
  const app = await acp_agent({
    name: 'test-agent',
    models: MODELS,
    flow: (session) => {
      const model = session.model()
      if (model === throw_for) throw new Error(`no flow for ${String(model)}`)
      built.push({ session, model })
      return step('answer', (_: AcpTurn) => `on ${String(model)}`)
    },
    to_input: (turn) => turn,
    ...config,
  })
  return { app, built }
}

/** The reply text of the turn `text` starts. */
async function reply_to(session: Awaited<ReturnType<typeof open_session>>['session'], text: string): Promise<string> {
  await session.prompt(text)
  const turn = await read_turn(session)
  return turn.updates
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => (update.content.type === 'text' ? update.content.text : ''))
    .join('')
}

describe('acp_agent: models', () => {
  it('reports the model beside the mode, starting on the default, and builds the flow for it', async () => {
    const { app, built } = await model_agent()
    const { agent } = connect_client(app)
    await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const response = await agent.request('session/new', { cwd: tmpdir(), mcpServers: [] })
    expect(response.configOptions?.map((option) => [option.id, option.currentValue])).toEqual([
      ['mode', 'manual'],
      ['model', 'sonnet'],
    ])
    expect(built.map((entry) => entry.model)).toEqual(['sonnet'])
  })

  it('builds the flow again for the model the user picks, which answers from the next turn on', async () => {
    const { app, built } = await model_agent()
    const { agent, session } = await open_session(app)
    expect(await reply_to(session, 'first')).toBe('on sonnet')
    const response = await agent.request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'model',
      value: 'gpt',
    })
    expect(response.configOptions.map((option) => [option.id, option.currentValue])).toEqual([
      ['mode', 'manual'],
      ['model', 'gpt'],
    ])
    expect(built.map((entry) => entry.model)).toEqual(['sonnet', 'gpt'])
    expect(built[1]?.session).toBe(built[0]?.session)
    expect(built[0]?.session.model()).toBe('gpt')
    expect(await reply_to(session, 'second')).toBe('on gpt')
  })

  it('refuses a model it does not offer, naming the ones it does', async () => {
    const { app } = await model_agent()
    const { agent, session } = await open_session(app)
    await expect(
      agent.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: 'opus' }),
    ).rejects.toMatchObject({
      code: -32602,
      message: 'Invalid params: unknown model "opus"; choose one of sonnet, gpt',
      data: { value: 'opus' },
    })
  })

  it('keeps the session on its model when the flow builder throws for the new one', async () => {
    const { app } = await model_agent({ throw_for: 'gpt' })
    const { agent, session } = await open_session(app)
    await expect(
      agent.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: 'gpt' }),
    ).rejects.toThrow('no flow for gpt')
    expect(await reply_to(session, 'still')).toBe('on sonnet')
  })

  it('names both of its options when refusing an unknown one', async () => {
    const { app } = await model_agent()
    const { agent, session } = await open_session(app)
    await expect(
      agent.request('session/set_config_option', { sessionId: session.sessionId, configId: 'effort', value: 'high' }),
    ).rejects.toThrow('unknown config option effort; the options are mode and model')
  })

  it('refuses a model pick from an agent that offers no models, as it would any unknown option', async () => {
    const app = await acp_agent({ name: 'test-agent', flow: step('noop', () => '') })
    const { agent, session } = await open_session(app)
    await expect(
      agent.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: 'gpt' }),
    ).rejects.toThrow('unknown config option model; the only one is mode')
  })

  it('sends the model with every mode switch, since an update carries every option', async () => {
    const updates: SessionUpdate[] = []
    const client_app = client().onNotification('session/update', (ctx) => {
      updates.push(ctx.params.update)
    })
    const { app } = await model_agent()
    const { agent, session } = await open_session(app, { client: client_app })
    await agent.request('session/set_mode', { sessionId: session.sessionId, modeId: 'auto' })
    await expect.poll(() => updates.length).toBe(2)
    const options = updates.find((update) => update.sessionUpdate === 'config_option_update')
    expect(options).toMatchObject({
      configOptions: [
        { id: 'mode', currentValue: 'auto' },
        { id: 'model', currentValue: 'sonnet' },
      ],
    })
  })

  it("draws the context ring against the session's model's own window, and the config's for a model without one", async () => {
    const usage = (input_tokens: number, output_tokens: number): TrajectoryEvent => ({
      kind: 'model_chunk',
      step_id: 'm',
      chunk: { kind: 'step_finish', step_index: 0, finish_reason: 'stop', usage: { input_tokens, output_tokens } },
    })
    const turns = [usage(30, 10), usage(20, 5)]
    const app = await acp_agent({
      name: 'test-agent',
      models: MODELS,
      context_window: 50,
      flow: () =>
        step('recording', (_: string, ctx) => {
          const event = turns.shift()
          if (event !== undefined) ctx.trajectory.record(event)
          return 'ok'
        }),
    })
    const { agent, session } = await open_session(app)
    await session.prompt('on sonnet')
    expect((await read_turn(session)).updates).toContainEqual({ sessionUpdate: 'usage_update', used: 40, size: 1000 })
    await agent.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: 'gpt' })
    await session.prompt('on gpt')
    expect((await read_turn(session)).updates).toContainEqual({ sessionUpdate: 'usage_update', used: 25, size: 50 })
  })

  it('sends no usage for a model with no window from an agent that names none', async () => {
    const app = await acp_agent({
      name: 'test-agent',
      models: [{ id: 'local' }],
      flow: () =>
        step('recording', (_: string, ctx) => {
          ctx.trajectory.record({
            kind: 'model_chunk',
            step_id: 'm',
            chunk: { kind: 'step_finish', step_index: 0, finish_reason: 'stop', usage: { input_tokens: 3, output_tokens: 1 } },
          })
          return 'ok'
        }),
    })
    const { session } = await open_session(app)
    await session.prompt('hello')
    expect((await read_turn(session)).updates.filter((update) => update.sessionUpdate === 'usage_update')).toEqual([])
  })

  it.each<[string, SessionUpdate[]]>([
    ['sonnet', [{ sessionUpdate: 'usage_update', used: 40, size: 1000 }]],
    ['gpt', []],
  ])("shows a session resumed on %s its usage again, against that model's window if it names one", async (model, expected) => {
    const store = filesystem_session_store({ root_dir: await scratch() })
    await store.save({
      id: 'kept',
      cwd: tmpdir(),
      additional_directories: [],
      mode: 'manual',
      model,
      title: null,
      updated_at: '2026-10-31T12:00:00.000Z',
      history: [{ role: 'user', text: 'hello' }],
      usage: { context_tokens: 40, cost_usd: 0, priced: false },
    })
    const updates: SessionUpdate[] = []
    const client_app = client().onNotification('session/update', (ctx) => {
      updates.push(ctx.params.update)
    })
    const { app } = await model_agent({ session_store: store })
    const { agent } = connect_client(app, client_app)
    await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await agent.request('session/resume', { sessionId: 'kept', cwd: tmpdir() })
    await agent.request('session/list', {})
    expect(updates).toEqual(expected)
  })

  it("keeps the session's model in the store and starts on it again once loaded", async () => {
    const root_dir = await scratch()
    const make = () => model_agent({ session_store: filesystem_session_store({ root_dir }) })
    const first = await make()
    const { agent, session } = await open_session(first.app)
    await agent.request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: 'gpt' })
    await reply_to(session, 'hello')
    expect(await filesystem_session_store({ root_dir }).load(session.sessionId)).toMatchObject({ model: 'gpt' })
    const second = await make()
    const reopened = connect_client(second.app)
    await reopened.agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const response = await reopened.agent.request('session/resume', { sessionId: session.sessionId, cwd: tmpdir() })
    expect(response.configOptions?.find((option) => option.id === 'model')?.currentValue).toBe('gpt')
    expect(second.built.map((entry) => entry.model)).toEqual(['gpt'])
  })

  it('keeps no model for an agent that offers none', async () => {
    const root_dir = await scratch()
    const app = await acp_agent({
      name: 'test-agent',
      flow: step('noop', () => 'ok'),
      session_store: filesystem_session_store({ root_dir }),
    })
    const { session } = await open_session(app)
    await session.prompt('hello')
    await read_turn(session)
    expect(await filesystem_session_store({ root_dir }).load(session.sessionId)).not.toHaveProperty('model')
  })
})
