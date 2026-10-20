import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { client } from '@agentclientprotocol/sdk'
import type { RequestPermissionRequest, SessionConfigOption, SessionUpdate } from '@agentclientprotocol/sdk'
import { model_step } from 'fascicle'
import { make_stub_engine } from '#testing'
import type { Tool, ToolApprovalRequest } from '#engine'
import { acp_agent } from '../acp_agent.js'
import { is_acp_mode, session_modes } from '../modes.js'
import { open_session, read_turn, read_until } from '../test/connect_client.js'
import type { OpenSession } from '../test/connect_client.js'
import { scripted_engine } from '../test/scripted_provider.js'
import type { AcpMode, AcpSession, ServeAcpConfig } from '../types.js'
import { workspace_tools } from '../workspace_tools.js'

/** A mode as a client sees it listed. */
type ListedMode = { readonly id: AcpMode; readonly name: string; readonly description: string }

const MODES: ReadonlyArray<ListedMode> = [
  { id: 'manual', name: 'Manual', description: 'Ask before every edit and every command' },
  { id: 'accept_edits', name: 'Accept edits', description: 'Edit files without asking, and ask before every command' },
  {
    id: 'auto',
    name: 'Auto',
    description: 'Edit files and run commands without asking, for a container or a throwaway worktree',
  },
]

/** The modes `ids` names as a client should see them listed, in the table's order. */
function listed(...ids: AcpMode[]): ListedMode[] {
  return MODES.filter(({ id }) => ids.includes(id))
}

/** The mode config option as the client should see it with `current` selected among `offered`. */
function mode_option(current: AcpMode, offered: ReadonlyArray<ListedMode> = MODES): SessionConfigOption {
  return {
    id: 'mode',
    name: 'Mode',
    description: 'When the agent asks before it edits a file or runs a command',
    category: 'mode',
    type: 'select',
    currentValue: current,
    options: offered.map(({ id, name, description }) => ({ value: id, name, description })),
  }
}

/** The two updates a switch to `mode` sends, in order, from an agent that offers `offered`. */
function switched_to(mode: AcpMode, offered: ReadonlyArray<ListedMode> = MODES): SessionUpdate[] {
  return [
    { sessionUpdate: 'current_mode_update', currentModeId: mode },
    { sessionUpdate: 'config_option_update', configOptions: [mode_option(mode, offered)] },
  ]
}

function is_config_update(update: SessionUpdate): boolean {
  return update.sessionUpdate === 'config_option_update'
}

/**
 * Open a session on an agent whose flow is never prompted, keeping the
 * `AcpSession` its builder was handed so a test can read its mode.
 */
async function open(
  options: { readonly default_mode?: AcpMode; readonly modes?: ReadonlyArray<AcpMode> } = {},
): Promise<OpenSession & { readonly built: AcpSession }> {
  const built: AcpSession[] = []
  const reply = model_step({ engine: make_stub_engine([{ prefix: '', content: 'ok' }]), model: 'stub-model' })
  const app = await acp_agent({
    ...options,
    name: 'modes',
    flow: (session) => {
      built.push(session)
      return reply
    },
  })
  const opened = await open_session(app)
  const [session] = built
  if (session === undefined) throw new Error('session/new built no flow')
  return { ...opened, built: session }
}

describe('modes: session/new', () => {
  it('reports the modes both ways, starting in manual', async () => {
    const { session, built } = await open()
    expect(session.modes).toEqual({ currentModeId: 'manual', availableModes: MODES })
    expect(session.newSessionResponse.configOptions).toEqual([mode_option('manual')])
    expect(built.mode()).toBe('manual')
  })

  it.each<AcpMode>(['accept_edits', 'auto'])('starts in a default_mode of %s, both ways and in the flow', async (mode) => {
    const { session, built } = await open({ default_mode: mode })
    expect(session.modes?.currentModeId).toBe(mode)
    expect(session.newSessionResponse.configOptions).toEqual([mode_option(mode)])
    expect(built.mode()).toBe(mode)
  })
})

describe('modes: switching', () => {
  it('switches with session/set_mode and tells the client both ways', async () => {
    const { agent, session, built } = await open()
    const response = await agent.request('session/set_mode', { sessionId: session.sessionId, modeId: 'auto' })
    expect(response).toEqual({})
    expect(built.mode()).toBe('auto')
    expect(await read_until(session, is_config_update)).toEqual(switched_to('auto'))
  })

  it('switches with session/set_config_option, answers with every option, and tells the client both ways', async () => {
    const { agent, session, built } = await open()
    const response = await agent.request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'mode',
      value: 'accept_edits',
    })
    expect(response).toEqual({ configOptions: [mode_option('accept_edits')] })
    expect(built.mode()).toBe('accept_edits')
    expect(await read_until(session, is_config_update)).toEqual(switched_to('accept_edits'))
  })

  it('keeps the two forms in step whichever setter the client uses next', async () => {
    const { agent, session, built } = await open({ default_mode: 'auto' })
    const { sessionId } = session
    await agent.request('session/set_config_option', { sessionId, configId: 'mode', value: 'accept_edits' })
    await agent.request('session/set_mode', { sessionId, modeId: 'manual' })
    expect(built.mode()).toBe('manual')
    const first = await read_until(session, is_config_update)
    const second = await read_until(session, is_config_update)
    expect([...first, ...second]).toEqual([...switched_to('accept_edits'), ...switched_to('manual')])
  })

  it('switches before the client hears of it, so each update goes out with the new mode in force', async () => {
    const seen: AcpMode[] = []
    const modes = session_modes({ modes: ['manual', 'accept_edits', 'auto'], default_mode: 'manual' }, async () => {
      seen.push(modes.current())
    })
    await modes.switch_to('auto')
    expect(seen).toEqual(['auto', 'auto'])
    expect(modes.current()).toBe('auto')
  })
})

describe('modes: refusals', () => {
  const known = 'choose one of manual, accept_edits, auto'

  it('refuses a mode it does not know from either setter, sends nothing, and keeps the mode it had', async () => {
    const { agent, session, built } = await open()
    const { sessionId } = session
    await expect(agent.request('session/set_mode', { sessionId, modeId: 'plan' })).rejects.toMatchObject({
      code: -32602,
      message: `Invalid params: unknown mode "plan"; ${known}`,
      data: { modeId: 'plan' },
    })
    await expect(
      agent.request('session/set_config_option', { sessionId, configId: 'mode', value: 'toString' }),
    ).rejects.toMatchObject({
      code: -32602,
      message: `Invalid params: unknown mode "toString"; ${known}`,
      data: { value: 'toString' },
    })
    await expect(
      agent.request('session/set_config_option', { sessionId, configId: 'mode', type: 'boolean', value: true }),
    ).rejects.toMatchObject({ code: -32602, message: `Invalid params: unknown mode true; ${known}`, data: { value: true } })
    expect(built.mode()).toBe('manual')
    // The first updates after the refusals are the next switch's, so the refusals sent none.
    await agent.request('session/set_mode', { sessionId, modeId: 'accept_edits' })
    expect(await read_until(session, is_config_update)).toEqual(switched_to('accept_edits'))
  })

  it('refuses a config option it does not have', async () => {
    const { agent, session, built } = await open()
    const request = { sessionId: session.sessionId, configId: 'model', value: 'auto' }
    await expect(agent.request('session/set_config_option', request)).rejects.toMatchObject({
      code: -32602,
      message: 'Invalid params: unknown config option model; the only one is mode',
      data: { configId: 'model' },
    })
    expect(built.mode()).toBe('manual')
  })

  it('refuses either setter for a session it never started', async () => {
    const { agent } = await open()
    const refusal = {
      code: -32602,
      message: 'Invalid params: unknown session nope; start one with session/new first',
      data: { sessionId: 'nope' },
    }
    await expect(agent.request('session/set_mode', { sessionId: 'nope', modeId: 'auto' })).rejects.toMatchObject(refusal)
    await expect(
      agent.request('session/set_config_option', { sessionId: 'nope', configId: 'mode', value: 'auto' }),
    ).rejects.toMatchObject(refusal)
  })

  it.each([
    ['manual', true],
    ['accept_edits', true],
    ['auto', true],
    ['plan', false],
    ['toString', false],
    ['', false],
    [true, false],
    [undefined, false],
    // An array keys an object by its string, which here would be `auto`.
    [['auto'], false],
  ])('takes %j as a mode: %s', (id, expected) => {
    expect(is_acp_mode(id)).toBe(expected)
  })
})

describe('modes: the modes an agent offers', () => {
  const offered = listed('manual', 'accept_edits')

  it("reports only the offered modes both ways, in the table's order, a mode listed twice counted once", async () => {
    const { session, built } = await open({ modes: ['auto', 'manual', 'auto'] })
    expect(session.modes).toEqual({ currentModeId: 'manual', availableModes: listed('manual', 'auto') })
    expect(session.newSessionResponse.configOptions).toEqual([mode_option('manual', listed('manual', 'auto'))])
    expect(built.mode()).toBe('manual')
  })

  it('starts in the first offered mode when the config leaves Manual out and sets no default_mode', async () => {
    const { session, built } = await open({ modes: ['auto', 'accept_edits'] })
    expect(session.modes).toEqual({ currentModeId: 'accept_edits', availableModes: listed('accept_edits', 'auto') })
    expect(session.newSessionResponse.configOptions).toEqual([
      mode_option('accept_edits', listed('accept_edits', 'auto')),
    ])
    expect(built.mode()).toBe('accept_edits')
  })

  it('starts in a default_mode the agent offers', async () => {
    const { session, built } = await open({ modes: ['manual', 'accept_edits'], default_mode: 'accept_edits' })
    expect(session.modes).toEqual({ currentModeId: 'accept_edits', availableModes: offered })
    expect(built.mode()).toBe('accept_edits')
  })

  it('refuses a mode it does not offer from either setter as one it does not know, sends nothing, and keeps the mode', async () => {
    const { agent, session, built } = await open({ modes: ['manual', 'accept_edits'] })
    const { sessionId } = session
    const message = 'Invalid params: unknown mode "auto"; choose one of manual, accept_edits'
    await expect(agent.request('session/set_mode', { sessionId, modeId: 'auto' })).rejects.toMatchObject({
      code: -32602,
      message,
      data: { modeId: 'auto' },
    })
    await expect(
      agent.request('session/set_config_option', { sessionId, configId: 'mode', value: 'auto' }),
    ).rejects.toMatchObject({ code: -32602, message, data: { value: 'auto' } })
    expect(built.mode()).toBe('manual')
    // The first updates after the refusals are the next switch's, so the refusals sent none.
    await agent.request('session/set_mode', { sessionId, modeId: 'accept_edits' })
    expect(await read_until(session, is_config_update)).toEqual(switched_to('accept_edits', offered))
  })

  it("lists only the offered modes in set_config_option's answer and in a switch's update", async () => {
    const { agent, session } = await open({ modes: ['manual', 'accept_edits'] })
    const response = await agent.request('session/set_config_option', {
      sessionId: session.sessionId,
      configId: 'mode',
      value: 'accept_edits',
    })
    expect(response).toEqual({ configOptions: [mode_option('accept_edits', offered)] })
    expect(await read_until(session, is_config_update)).toEqual(switched_to('accept_edits', offered))
  })
})

describe('modes: a config that offers no mode it can run', () => {
  /** The config's modes and default_mode as a caller with no types might pass them. */
  type Untyped = { readonly modes?: unknown; readonly default_mode?: unknown }

  /** Build an agent on `untyped`, as a caller whose config no type checked. */
  function build_with(untyped: Untyped, build: typeof acp_agent = acp_agent) {
    const config = untyped as Pick<ServeAcpConfig<string, string>, 'modes' | 'default_mode'>
    return build({ ...config, name: 'modes', flow: model_step({ engine: make_stub_engine([]), model: 'stub-model' }) })
  }

  afterEach(() => {
    vi.doUnmock('@agentclientprotocol/sdk')
    vi.resetModules()
  })

  it.each<[string, Untyped, string]>([
    [
      'an empty modes',
      { modes: [] },
      'acp_agent: modes is empty; list at least one of manual, accept_edits, auto, or leave modes out to offer all three',
    ],
    [
      'a modes that lists toString',
      { modes: ['manual', 'toString'] },
      `acp_agent: modes lists "toString", which isn't a mode; use one of manual, accept_edits, auto`,
    ],
    [
      'a default_mode outside modes',
      { modes: ['manual', 'accept_edits'], default_mode: 'auto' },
      `acp_agent: default_mode "auto" isn't one of the modes this agent offers (manual, accept_edits); add it to modes or leave default_mode out`,
    ],
    [
      'a default_mode that is no mode at all',
      { default_mode: 'plan' },
      `acp_agent: default_mode "plan" isn't one of the modes this agent offers (manual, accept_edits, auto); add it to modes or leave default_mode out`,
    ],
  ])('rejects %s as acp_agent is built', async (_, untyped, message) => {
    const failure: unknown = await build_with(untyped).catch((caught: unknown) => caught)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message })
  })

  it('rejects a bad config before it loads the SDK, so the error names the config and not the missing SDK', async () => {
    vi.resetModules()
    vi.doMock('@agentclientprotocol/sdk', () => {
      throw new Error('module not found (test)')
    })
    const { acp_agent: build } = await import('../acp_agent.js')
    await expect(build_with({}, build)).rejects.toMatchObject({ kind: 'acp_sdk_missing_error' })
    await expect(build_with({ modes: [] }, build)).rejects.toMatchObject({
      message:
        'acp_agent: modes is empty; list at least one of manual, accept_edits, auto, or leave modes out to offer all three',
    })
  })
})

describe('modes: when the workspace tools ask', () => {
  /** A session whose mode is whatever `mode` returns at the time. */
  function session_in(mode: () => AcpMode): AcpSession {
    return { id: 's', cwd: '/work', additional_directories: [], roots: ['/work'], client_capabilities: {}, mode, approve: () => false }
  }

  /** Whether the engine's approval check would ask before `tool` runs. */
  async function asks(tool: Tool): Promise<boolean> {
    const { needs_approval } = tool
    return typeof needs_approval === 'function' ? needs_approval({}) : needs_approval === true
  }

  async function table_for(session: AcpSession): Promise<Record<string, boolean>> {
    const tools = workspace_tools(session)
    const answers = await Promise.all(tools.map(async (tool) => [tool.name, await asks(tool)] as const))
    return Object.fromEntries(answers)
  }

  const reads = { read_file: false, list_files: false, search: false }

  it.each<[AcpMode, Record<string, boolean>]>([
    ['manual', { ...reads, write_file: true, edit_file: true, run_command: true }],
    ['accept_edits', { ...reads, write_file: false, edit_file: false, run_command: true }],
    ['auto', { ...reads, write_file: false, edit_file: false, run_command: false }],
  ])('in %s, asks before %j', async (mode, expected) => {
    expect(await table_for(session_in(() => mode))).toEqual(expected)
  })

  it('leaves the reads with no approval check at all', () => {
    const tools = workspace_tools(session_in(() => 'manual'))
    const unchecked = tools.filter((tool) => tool.needs_approval === undefined).map((tool) => tool.name)
    expect(unchecked).toEqual(['read_file', 'list_files', 'search'])
  })

  it('reads the mode at each call, so a switch holds from the next call on', async () => {
    let mode: AcpMode = 'manual'
    const tools = workspace_tools(session_in(() => mode))
    const before = await Promise.all(tools.map(asks))
    mode = 'auto'
    const after = await Promise.all(tools.map(asks))
    expect(before).toEqual([false, false, false, true, true, true])
    expect(after).toEqual([false, false, false, false, false, false])
  })
})

describe('modes: over the real tool loop', () => {
  const made: string[] = []

  afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it.each<[AcpMode, ReadonlyArray<[string, string]>]>([
    [
      'manual',
      [
        ['write_file', 'w'],
        ['edit_file', 'e'],
        ['run_command', 'c'],
      ],
    ],
    ['accept_edits', [['run_command', 'c']]],
    ['auto', []],
  ])('in %s, set over the wire, the engine asks before exactly %j', async (mode, expected) => {
    const cwd = await mkdtemp(join(tmpdir(), 'fascicle-acp-modes-'))
    made.push(cwd)
    await writeFile(join(cwd, 'a.txt'), 'one\n')
    const engine = scripted_engine([
      [
        { id: 'r', name: 'read_file', input: { path: 'a.txt' } },
        { id: 'l', name: 'list_files', input: {} },
        { id: 's', name: 'search', input: { pattern: 'one' } },
        { id: 'w', name: 'write_file', input: { path: 'b.txt', content: 'b\n' } },
        { id: 'e', name: 'edit_file', input: { path: 'a.txt', old_text: 'one', new_text: 'two' } },
        { id: 'c', name: 'run_command', input: { command: 'true' } },
      ],
      'done',
    ])
    const asked: Array<[string, string]> = []
    const approve = (request: ToolApprovalRequest): boolean => {
      asked.push([request.tool_name, request.tool_call_id])
      return true
    }
    const app = await acp_agent({
      name: 'modes',
      flow: (session) => model_step({ engine, id: 'coder', tools: workspace_tools(session), on_tool_approval: approve }),
    })
    const { agent, session } = await open_session(app, { session: { cwd } })
    await agent.request('session/set_mode', { sessionId: session.sessionId, modeId: mode })
    await session.prompt('go')
    const { stop_reason } = await read_turn(session)
    expect(stop_reason).toBe('end_turn')
    expect(asked).toEqual(expected)
  })

  it('asks before every command in an agent that leaves Auto out, until the client allows a command line always', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'fascicle-acp-modes-'))
    made.push(cwd)
    const engine = scripted_engine([
      [{ id: 'c1', name: 'run_command', input: { command: 'echo one' } }],
      'done',
      [{ id: 'c2', name: 'run_command', input: { command: 'echo two' } }],
      [{ id: 'c3', name: 'run_command', input: { command: 'echo one' } }],
      'done',
    ])
    const asked: Array<[AcpMode, string]> = []
    let mode: AcpMode = 'manual'
    const client_app = client().onRequest('session/request_permission', (ctx) => {
      const { toolCall, options }: RequestPermissionRequest = ctx.params
      asked.push([mode, toolCall.title ?? ''])
      const always = options.find((option) => option.kind === 'allow_always')
      return { outcome: { outcome: 'selected', optionId: always?.optionId ?? 'allow_once' } }
    })
    const app = await acp_agent({
      name: 'modes',
      modes: ['manual', 'accept_edits'],
      flow: (session) =>
        model_step({ engine, id: 'coder', tools: workspace_tools(session), on_tool_approval: session.approve }),
    })
    const { agent, session } = await open_session(app, { client: client_app, session: { cwd } })
    expect(session.modes?.availableModes.map(({ id }) => id)).toEqual(['manual', 'accept_edits'])
    await session.prompt('first')
    expect((await read_turn(session)).stop_reason).toBe('end_turn')
    mode = 'accept_edits'
    await agent.request('session/set_mode', { sessionId: session.sessionId, modeId: mode })
    await session.prompt('second')
    expect((await read_turn(session)).stop_reason).toBe('end_turn')
    expect(asked).toEqual([
      ['manual', 'echo one'],
      ['accept_edits', 'echo two'],
    ])
  })
})
