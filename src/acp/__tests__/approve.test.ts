import { getEventListeners } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { client } from '@agentclientprotocol/sdk'
import type {
  ClientContext,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk'
import { model_step } from 'fascicle'
import { sequence } from '#core'
import type { Step, TrajectoryEvent, TrajectoryLogger } from '#core'
import type { Engine, Tool, ToolApprovalRequest, TurnRequest } from '#engine'
import { json_schema_to_standard } from '#schema'
import { acp_agent } from '../acp_agent.js'
import { command_key, create_card_sync, session_approver } from '../approve.js'
import type { CardSync, PermissionAsker } from '../approve.js'
import { session_modes } from '../modes.js'
import { prompt_turn } from '../prompt_turn.js'
import { open_session, read_turn } from '../test/connect_client.js'
import { scripted_engine } from '../test/scripted_provider.js'
import type { ScriptedTurn } from '../test/scripted_provider.js'
import { resolve_roots } from '../tools/containment.js'
import type { AcpMode, AcpSession } from '../types.js'
import { workspace_tools } from '../workspace_tools.js'

const ALLOW = { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }
const REJECT = { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }

/** The "always" option a request offers, under the name it shows. */
function always(name: string): { optionId: string; name: string; kind: string } {
  return { optionId: 'allow_always', name, kind: 'allow_always' }
}

/** The client's answer when the user picks `optionId`. */
function choose(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId } }
}

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } }

/** The tool result the model reads for a call the approval refused. */
const REFUSED = JSON.stringify({ error: 'tool_approval_denied' })

/**
 * A scratch workspace for each test: `a.txt` holding two lines, under a
 * directory of its own.
 */
let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'fascicle-acp-approve-'))
  await writeFile(join(cwd, 'a.txt'), 'one\ntwo\n')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(cwd, { recursive: true, force: true })
})

/** Whether a file exists in the workspace. */
async function exists(path: string): Promise<boolean> {
  return stat(join(cwd, path)).then(
    () => true,
    () => false,
  )
}

/** Collect what's written to stderr from now on, writing none of it. */
function capture_stderr(): string[] {
  const writes: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  })
  return writes
}

/** A model call on the scripted engine with the session's workspace tools, asking through `session.approve`. */
function coder(engine: Engine, session: AcpSession, id = 'coder', extra: ReadonlyArray<Tool> = []): Step<string, string> {
  return model_step({ engine, id, tools: [...workspace_tools(session), ...extra], on_tool_approval: session.approve })
}

/** How a test's client answers a permission request. */
type Answer = (
  request: RequestPermissionRequest,
  signal: AbortSignal,
  agent: ClientContext,
) => RequestPermissionResponse | Promise<RequestPermissionResponse>

type WireRun = {
  readonly session_id: string
  readonly asked: ReadonlyArray<RequestPermissionRequest>
  readonly updates: ReadonlyArray<SessionUpdate>
  readonly stop_reason: StopReason
  /** Every request the model was sent, its tool results included. */
  readonly seen: ReadonlyArray<TurnRequest>
}

/**
 * Run one prompt turn over the wire of a session whose flow is one model
 * call on `script`, with a client that answers each permission request
 * through `answer`.
 */
async function wire_run(
  script: ReadonlyArray<ScriptedTurn>,
  answer: Answer,
  options: { readonly mode?: AcpMode; readonly extra?: ReadonlyArray<Tool> } = {},
): Promise<WireRun> {
  const seen: TurnRequest[] = []
  const engine = scripted_engine(script, seen)
  const asked: RequestPermissionRequest[] = []
  const client_app = client().onRequest('session/request_permission', (ctx) => {
    asked.push(ctx.params)
    return answer(ctx.params, ctx.signal, ctx.agent)
  })
  const app = await acp_agent({
    name: 'approve',
    ...(options.mode === undefined ? {} : { default_mode: options.mode }),
    flow: (session) => coder(engine, session, 'coder', options.extra),
  })
  const { session } = await open_session(app, { client: client_app, session: { cwd } })
  await session.prompt('go')
  const { updates, stop_reason } = await read_turn(session)
  return { session_id: session.sessionId, asked, updates, stop_reason, seen }
}

/** The id of the card the client was sent for raw call `raw` of model call `step`. */
function card_id(updates: ReadonlyArray<SessionUpdate>, raw: string, step = 'coder'): string {
  for (const update of updates) {
    if (update.sessionUpdate === 'tool_call' && update.toolCallId.endsWith(`:${step}:1:${raw}`)) return update.toolCallId
  }
  throw new Error(`no card was opened for ${step}'s call ${raw}`)
}

/** What the model read back for raw call `raw`, from the last request it was sent. */
function tool_result(seen: ReadonlyArray<TurnRequest>, raw: string): string | undefined {
  for (const message of seen.at(-1)?.messages ?? []) {
    if (message.role === 'tool' && message.tool_call_id === raw) return message.content
  }
  return undefined
}

/** The titles of the calls the client was asked about, in order. */
function titles(asked: ReadonlyArray<RequestPermissionRequest>): unknown[] {
  return asked.map((request) => request.toolCall.title)
}

/** The mode switches the client was told of, in order. */
function mode_switches(updates: ReadonlyArray<SessionUpdate>): string[] {
  return updates.flatMap((update) => (update.sessionUpdate === 'current_mode_update' ? [update.currentModeId] : []))
}

describe('approve: what the request shows', () => {
  it('shows an edit with its diff and the line it lands on, on the card the client already has', async () => {
    const input = { path: 'a.txt', old_text: 'two', new_text: 'TWO' }
    const run = await wire_run([[{ id: 'e', name: 'edit_file', input }], 'done'], () => choose('allow_once'))
    const path = join(cwd, 'a.txt')
    expect(run.asked).toEqual([
      {
        sessionId: run.session_id,
        toolCall: {
          toolCallId: card_id(run.updates, 'e'),
          title: 'Edit a.txt',
          kind: 'edit',
          rawInput: input,
          locations: [{ path, line: 2 }],
          content: [{ type: 'diff', path, oldText: 'one\ntwo\n', newText: 'one\nTWO\n' }],
        },
        options: [ALLOW, always('Allow all edits this session'), REJECT],
      },
    ])
    expect(await readFile(path, 'utf8')).toBe('one\nTWO\n')
  })

  it('shows a new file as a diff from nothing, offering the same three options', async () => {
    const input = { path: 'new/b.txt', content: 'b\n' }
    const run = await wire_run([[{ id: 'w', name: 'write_file', input }], 'done'], () => choose('allow_once'))
    const path = join(cwd, 'new', 'b.txt')
    expect(run.asked).toEqual([
      {
        sessionId: run.session_id,
        toolCall: {
          toolCallId: card_id(run.updates, 'w'),
          title: 'Write new/b.txt',
          kind: 'edit',
          rawInput: input,
          locations: [{ path }],
          content: [{ type: 'diff', path, oldText: null, newText: 'b\n' }],
        },
        options: [ALLOW, always('Allow all edits this session'), REJECT],
      },
    ])
  })

  it('shows a command as its command line, offering to always allow its program and first argument', async () => {
    const input = { command: 'pnpm test --watch' }
    const run = await wire_run([[{ id: 'c', name: 'run_command', input }], 'done'], () => choose('reject_once'))
    expect(run.asked).toEqual([
      {
        sessionId: run.session_id,
        toolCall: { toolCallId: card_id(run.updates, 'c'), title: 'pnpm test --watch', kind: 'execute', rawInput: input },
        options: [ALLOW, always('Always allow `pnpm test` this session'), REJECT],
      },
    ])
  })

  it('offers no "always" for a command with shell control syntax', async () => {
    const run = await wire_run(
      [[{ id: 'c', name: 'run_command', input: { command: 'echo one && echo two' } }], 'done'],
      () => choose('allow_once'),
    )
    expect(run.asked.map((request) => request.options)).toEqual([[ALLOW, REJECT]])
    expect(tool_result(run.seen, 'c')).toContain('one\ntwo')
  })

  it("shows why an edit can't be worked out instead of a diff, and the call fails with it once allowed", async () => {
    const input = { path: 'a.txt', old_text: 'three', new_text: 'THREE' }
    const run = await wire_run([[{ id: 'e', name: 'edit_file', input }], 'done'], () => choose('allow_once'))
    const why = "old_text doesn't appear in a.txt; it has to match the file exactly"
    const [request] = run.asked
    expect(request?.toolCall.content).toEqual([{ type: 'content', content: { type: 'text', text: expect.stringContaining(why) } }])
    expect(tool_result(run.seen, 'e')).toContain(why)
  })

  it('shows the change limit in place of a diff for a file one byte over, and a diff for one at the limit', async () => {
    await writeFile(join(cwd, 'over.txt'), `x\n${'a'.repeat(999_999)}`)
    await writeFile(join(cwd, 'at.txt'), `x\n${'a'.repeat(999_998)}`)
    const over = { path: 'over.txt', old_text: 'x', new_text: 'y' }
    const at = { path: 'at.txt', old_text: 'x', new_text: 'y' }
    const run = await wire_run(
      [
        [
          { id: 'o', name: 'edit_file', input: over },
          { id: 'a', name: 'edit_file', input: at },
        ],
        'done',
      ],
      () => choose('allow_once'),
    )
    const why = 'over.txt is 1000001 bytes, over the 1000000 that write_file and edit_file read to show a change as a diff; change it with run_command instead'
    const path = join(cwd, 'at.txt')
    expect(run.asked.map((request) => request.toolCall.content)).toEqual([
      [{ type: 'content', content: { type: 'text', text: why } }],
      [{ type: 'diff', path, oldText: `x\n${'a'.repeat(999_998)}`, newText: `y\n${'a'.repeat(999_998)}` }],
    ])
    expect(tool_result(run.seen, 'o')).toContain(why)
  })

  it('asks about a tool of the flow\'s own by its name, with no "always" on offer, even for a command in its input', async () => {
    const deploy: Tool = {
      name: 'deploy',
      description: 'Deploy the site',
      input_schema: json_schema_to_standard({
        type: 'object',
        properties: { command: { type: 'string' } },
        additionalProperties: false,
      }),
      needs_approval: true,
      execute: () => 'deployed',
    }
    const input = { command: 'ship it' }
    const run = await wire_run([[{ id: 'd', name: 'deploy', input }], 'done'], () => choose('allow_once'), {
      extra: [deploy],
    })
    expect(run.asked).toEqual([
      {
        sessionId: run.session_id,
        toolCall: { toolCallId: card_id(run.updates, 'd'), title: 'deploy', kind: 'other', rawInput: input },
        options: [ALLOW, REJECT],
      },
    ])
    expect(tool_result(run.seen, 'd')).toBe('deployed')
  })
})

describe('approve: what each answer does', () => {
  it('runs a call allowed once, and asks again before the next', async () => {
    const run = await wire_run(
      [
        [{ id: 'w1', name: 'write_file', input: { path: 'b.txt', content: 'b\n' } }],
        [{ id: 'w2', name: 'write_file', input: { path: 'c.txt', content: 'c\n' } }],
        'done',
      ],
      () => choose('allow_once'),
    )
    expect(titles(run.asked)).toEqual(['Write b.txt', 'Write c.txt'])
    expect(await readFile(join(cwd, 'c.txt'), 'utf8')).toBe('c\n')
    expect(mode_switches(run.updates)).toEqual([])
  })

  it('switches to Accept edits on "Allow all edits", tells the client both ways, and still asks before a command', async () => {
    const run = await wire_run(
      [
        [{ id: 'e', name: 'edit_file', input: { path: 'a.txt', old_text: 'two', new_text: 'TWO' } }],
        [{ id: 'w', name: 'write_file', input: { path: 'b.txt', content: 'b\n' } }],
        [{ id: 'c', name: 'run_command', input: { command: 'echo ran' } }],
        'done',
      ],
      (request) => choose(request.toolCall.kind === 'edit' ? 'allow_always' : 'allow_once'),
    )
    expect(titles(run.asked)).toEqual(['Edit a.txt', 'echo ran'])
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('one\nTWO\n')
    expect(mode_switches(run.updates)).toEqual(['accept_edits'])
    const config = run.updates.filter((update) => update.sessionUpdate === 'config_option_update')
    expect(config).toEqual([
      { sessionUpdate: 'config_option_update', configOptions: [expect.objectContaining({ currentValue: 'accept_edits' })] },
    ])
    expect(await readFile(join(cwd, 'b.txt'), 'utf8')).toBe('b\n')
  })

  it('leaves a session the client moved past Manual while it asked where the client put it', async () => {
    const run = await wire_run(
      [
        [{ id: 'e', name: 'edit_file', input: { path: 'a.txt', old_text: 'two', new_text: 'TWO' } }],
        [{ id: 'c', name: 'run_command', input: { command: 'echo ran' } }],
        'done',
      ],
      async (request, _signal, agent) => {
        await agent.request('session/set_mode', { sessionId: request.sessionId, modeId: 'auto' })
        return choose('allow_always')
      },
    )
    expect(titles(run.asked)).toEqual(['Edit a.txt'])
    expect(mode_switches(run.updates)).toEqual(['auto'])
  })

  it('stops asking about a command once its key is always allowed, and asks about one with another key', async () => {
    const run = await wire_run(
      [
        [{ id: 'c1', name: 'run_command', input: { command: 'echo one' } }],
        [{ id: 'c2', name: 'run_command', input: { command: 'echo one two' } }],
        [{ id: 'c3', name: 'run_command', input: { command: 'echo two' } }],
        'done',
      ],
      () => choose('allow_always'),
    )
    expect(titles(run.asked)).toEqual(['echo one', 'echo two'])
    expect(tool_result(run.seen, 'c1')).toContain('one')
    expect(tool_result(run.seen, 'c2')).toContain('one two')
    expect(mode_switches(run.updates)).toEqual([])
  })

  it('never lets a grant cover a command with shell control syntax', async () => {
    const run = await wire_run(
      [
        [{ id: 'c1', name: 'run_command', input: { command: 'echo one' } }],
        [{ id: 'c2', name: 'run_command', input: { command: 'echo one; echo two' } }],
        'done',
      ],
      (request) => choose(request.options.length === 3 ? 'allow_always' : 'reject_once'),
    )
    expect(titles(run.asked)).toEqual(['echo one', 'echo one; echo two'])
    expect(tool_result(run.seen, 'c2')).toBe(REFUSED)
  })

  it.each<[string, RequestPermissionResponse]>([
    ['a rejection', choose('reject_once')],
    ['a cancelled outcome', CANCELLED],
    ['an option the request never offered', choose('allow_forever')],
  ])('refuses the call on %s: it never runs, and the model and the card both say so', async (_, answer) => {
    const run = await wire_run([[{ id: 'w', name: 'write_file', input: { path: 'b.txt', content: 'b\n' } }], 'done'], () => answer)
    expect(run.stop_reason).toBe('end_turn')
    expect(await exists('b.txt')).toBe(false)
    expect(tool_result(run.seen, 'w')).toBe(REFUSED)
    expect(run.updates.at(-2)).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: card_id(run.updates, 'w'),
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'tool_approval_denied' } }],
    })
  })

  it('refuses an "always" the request never offered, as an answer rather than a failure', async () => {
    const writes = capture_stderr()
    const run = await wire_run(
      [[{ id: 'c', name: 'run_command', input: { command: 'echo one | cat' } }], 'done'],
      () => choose('allow_always'),
    )
    expect(tool_result(run.seen, 'c')).toBe(REFUSED)
    expect(writes).toEqual([])
  })

  it('refuses the call when the request fails, and says so on stderr', async () => {
    const writes = capture_stderr()
    const run = await wire_run([[{ id: 'w', name: 'write_file', input: { path: 'b.txt', content: 'b\n' } }], 'done'], () => {
      throw new Error('the dialog closed')
    })
    expect(run.stop_reason).toBe('end_turn')
    expect(await exists('b.txt')).toBe(false)
    expect(tool_result(run.seen, 'w')).toBe(REFUSED)
    expect(writes).toEqual([
      expect.stringMatching(
        /^fascicle\/acp: asking the client to approve write_file failed \(.+\), so the call was refused; check that the client answers session\/request_permission\n$/,
      ),
    ])
  })

  it('asks nothing in Auto', async () => {
    const run = await wire_run(
      [
        [
          { id: 'w', name: 'write_file', input: { path: 'b.txt', content: 'b\n' } },
          { id: 'e', name: 'edit_file', input: { path: 'a.txt', old_text: 'two', new_text: 'TWO' } },
          { id: 'c', name: 'run_command', input: { command: 'echo ran' } },
        ],
        'done',
      ],
      () => choose('reject_once'),
      { mode: 'auto' },
    )
    expect(run.asked).toEqual([])
    expect(tool_result(run.seen, 'c')).toContain('ran')
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('one\nTWO\n')
  })
})

describe('approve: a turn cancelled while the request is open', () => {
  it('withdraws the request, refuses the call, and ends the turn cancelled', async () => {
    const engine = scripted_engine([[{ id: 'w', name: 'write_file', input: { path: 'b.txt', content: 'b\n' } }], 'done'])
    const { promise: asked, resolve: on_ask } = Promise.withResolvers<void>()
    const { promise: withdrawn, resolve: on_withdraw } = Promise.withResolvers<void>()
    const client_app = client().onRequest('session/request_permission', async (ctx) => {
      on_ask()
      if (!ctx.signal.aborted) await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve))
      on_withdraw()
      return CANCELLED
    })
    const app = await acp_agent({ name: 'approve', flow: (session) => coder(engine, session) })
    const { agent, session } = await open_session(app, { client: client_app, session: { cwd } })
    const writes = capture_stderr()
    const response = session.prompt('go')
    await asked
    await agent.notify('session/cancel', { sessionId: session.sessionId })
    await withdrawn
    await expect(response).resolves.toEqual({ stopReason: 'cancelled' })
    expect(await exists('b.txt')).toBe(false)
    expect(writes).toEqual([])
  })
})

/** A record of every call a logger got. */
function recording_logger(): { readonly logger: TrajectoryLogger; readonly calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    logger: {
      record: (event) => calls.push(['record', event]),
      start_span: (name, meta) => {
        calls.push(['start_span', name, meta])
        return `inner-${name}`
      },
      end_span: (id, meta) => calls.push(['end_span', id, meta]),
    },
  }
}

/** Let every pending promise callback run. */
async function settle_pending(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/** Whether `promise` has settled by the time pending callbacks have run. */
async function has_settled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  await settle_pending()
  return settled
}

/** A `model_chunk` event opening raw call `id`. */
function call_start(id: string): TrajectoryEvent {
  return { kind: 'model_chunk', step_id: 'coder', chunk: { kind: 'tool_call_start', id, name: 'write_file', step_index: 0 } }
}

/** The update that opens card `id`. */
function opens(id: string): SessionUpdate {
  return { sessionUpdate: 'tool_call', toolCallId: id, title: 'write_file', kind: 'other', status: 'pending' }
}

describe('approve: the card sync', () => {
  it('passes every call through to the inner logger, its span ids included', () => {
    const { logger: inner, calls } = recording_logger()
    const logger = create_card_sync().start(inner)
    logger.record({ kind: 'emit', n: 1 })
    expect(logger.start_span('step', { id: 's' })).toBe('inner-step')
    logger.end_span('inner-step', { ok: true })
    expect(calls).toEqual([
      ['record', { kind: 'emit', n: 1 }],
      ['start_span', 'step', { id: 's' }],
      ['end_span', 'inner-step', { ok: true }],
    ])
  })

  it('gives each span an id of its own when the turn has no logger', () => {
    const logger = create_card_sync().start(undefined)
    const first = logger.start_span('step')
    const second = logger.start_span('step')
    expect(first).toMatch(/^step:.+/)
    expect(second).not.toBe(first)
    logger.record({ kind: 'emit' })
    logger.end_span(first)
  })

  it('catches up once the consumer has sent every event recorded so far, spans included', async () => {
    const sync = create_card_sync()
    const logger = sync.start(undefined)
    logger.record({ kind: 'emit' })
    const span = logger.start_span('step')
    logger.end_span(span)
    const caught_up = sync.caught_up()
    logger.record({ kind: 'emit', late: true })
    sync.sent({ kind: 'emit' }, [])
    sync.sent({ kind: 'span_start' }, [])
    expect(await has_settled(caught_up)).toBe(false)
    sync.sent({ kind: 'span_end' }, [])
    expect(await has_settled(caught_up)).toBe(true)
  })

  it('is caught up at once when the consumer has sent everything', async () => {
    const sync = create_card_sync()
    expect(await has_settled(sync.caught_up())).toBe(true)
    sync.start(undefined).record({ kind: 'emit' })
    sync.sent({ kind: 'emit' }, [])
    expect(await has_settled(sync.caught_up())).toBe(true)
  })

  it('answers with the latest card the client was sent for a raw id', () => {
    const sync = create_card_sync()
    sync.start(undefined)
    expect(sync.card_for('x')).toBeUndefined()
    sync.sent(call_start('x'), [opens('first')])
    expect(sync.card_for('x')).toBe('first')
    sync.sent(call_start('x'), [opens('second')])
    sync.sent(call_start('x'), [])
    sync.sent({ kind: 'model_chunk', step_id: 'coder', chunk: { kind: 'tool_call_end', id: 'x' } }, [opens('third')])
    sync.sent({ kind: 'emit', chunk: { kind: 'tool_call_start', id: 'x' } }, [opens('fourth')])
    sync.sent({ kind: 'model_chunk', step_id: 'coder', chunk: { kind: 'tool_call_start', id: 7 } }, [opens('fifth')])
    sync.sent({ kind: 'model_chunk', step_id: 'coder', chunk: 'tool_call_start' }, [opens('sixth')])
    expect(sync.card_for('x')).toBe('second')
    expect(sync.card_for('7')).toBeUndefined()
    const text: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }
    sync.sent(call_start('y'), [text, opens('after text')])
    expect(sync.card_for('y')).toBe('after text')
  })

  it("forgets the last turn's cards and counts when the next turn starts", async () => {
    const sync = create_card_sync()
    const logger = sync.start(undefined)
    logger.record({ kind: 'emit' })
    sync.sent(call_start('x'), [opens('first')])
    logger.record({ kind: 'emit' })
    const left_behind = sync.caught_up()
    sync.start(undefined)
    expect(sync.card_for('x')).toBeUndefined()
    expect(await has_settled(sync.caught_up())).toBe(true)
    expect(await has_settled(left_behind)).toBe(false)
  })
})

describe('approve: command_key', () => {
  it.each<[unknown, string | undefined]>([
    ['pnpm test', 'pnpm test'],
    ['pnpm test --watch src', 'pnpm test'],
    ['git status --short', 'git status'],
    ['ls -la', 'ls'],
    ['ls', 'ls'],
    ['  git \t status  ', 'git status'],
    ['$HOME/bin/tool run', '$HOME/bin/tool run'],
    ['', undefined],
    ['   ', undefined],
    ['echo a; rm b', undefined],
    ['echo a & rm b', undefined],
    ['echo a | sh', undefined],
    ['echo a > b', undefined],
    ['sh < b', undefined],
    ['echo `rm b`', undefined],
    ['echo $(rm b)', undefined],
    ['echo a\nrm b', undefined],
  ])('keys %j as %j', (command, key) => {
    expect(command_key({ command })).toBe(key)
  })

  it.each([[{ command: 3 }], [{}], [null], ['pnpm test']])('has no key for an input of %j', (input) => {
    expect(command_key(input)).toBeUndefined()
  })
})

/**
 * A session in Manual over the scratch workspace, asking through an
 * approver over `cards` and `ask`.
 */
async function manual_session(cards: CardSync, ask: PermissionAsker): Promise<AcpSession> {
  const roots = await resolve_roots([cwd])
  const modes = session_modes('manual', async () => {})
  const approver = session_approver({ modes, cards, ask })
  const session: AcpSession = {
    id: 'session-1',
    cwd,
    additional_directories: [],
    roots,
    client_capabilities: {},
    mode: modes.current,
    approve: (request) => approver(session, request),
  }
  return session
}

/** An approval request for writing `b.txt`, under `abort`. */
function write_request(abort: AbortSignal): ToolApprovalRequest {
  return { tool_name: 'write_file', input: { path: 'b.txt', content: 'b\n' }, step_index: 0, tool_call_id: 'w', abort }
}

describe('approve: waiting for the client', () => {
  it('asks only once the client has every update the run recorded, and points at the card each call opened', async () => {
    const engine = scripted_engine([
      [{ id: 'ollama_call_0_0', name: 'write_file', input: { path: 'b.txt', content: 'b\n' } }],
      'first done',
      [{ id: 'ollama_call_0_0', name: 'write_file', input: { path: 'c.txt', content: 'c\n' } }],
      'second done',
    ])
    const sent: SessionUpdate[] = []
    const send = async (update: SessionUpdate): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 2))
      sent.push(update)
    }
    const at_ask: Array<{ readonly card: string; readonly sent: ReadonlyArray<SessionUpdate> }> = []
    const cards = create_card_sync()
    const session = await manual_session(cards, async (request) => {
      at_ask.push({ card: request.toolCall.toolCallId, sent: [...sent] })
      return choose('allow_once')
    })
    const flow = sequence([coder(engine, session, 'first'), coder(engine, session, 'second')])
    const record = { session, flow, history: [], cards, last_turn: null }
    await prompt_turn({ name: 'approve', flow }, record, [{ type: 'text', text: 'go' }], new AbortController().signal, send)
    expect(at_ask.map(({ card }) => card)).toEqual([
      card_id(sent, 'ollama_call_0_0', 'first'),
      card_id(sent, 'ollama_call_0_0', 'second'),
    ])
    for (const { card, sent: before } of at_ask) {
      const statuses = before.flatMap((update) =>
        'toolCallId' in update && update.toolCallId === card ? [update.sessionUpdate, update.status] : [],
      )
      expect(statuses).toEqual(['tool_call', 'pending', 'tool_call_update', 'in_progress'])
    }
  })

  it('opens a card of its own for a call the client was never shown', async () => {
    const asked: RequestPermissionRequest[] = []
    const session = await manual_session(create_card_sync(), async (request) => {
      asked.push(request)
      return choose('allow_once')
    })
    expect(await session.approve(write_request(new AbortController().signal))).toBe(true)
    const path = join(cwd, 'b.txt')
    expect(asked[0]?.toolCall).toStrictEqual({
      toolCallId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      title: 'Write b.txt',
      kind: 'edit',
      rawInput: { path: 'b.txt', content: 'b\n' },
      locations: [{ path }],
      content: [{ type: 'diff', path, oldText: null, newText: 'b\n' }],
    })
  })

  it('refuses a cancelled outcome whatever else it carries', async () => {
    const outcome = { outcome: 'cancelled' as const, optionId: 'allow_once' }
    const session = await manual_session(create_card_sync(), async () => ({ outcome }))
    expect(await session.approve(write_request(new AbortController().signal))).toBe(false)
  })

  it('leaves no listener on the turn\'s signal once it has its answer', async () => {
    const session = await manual_session(create_card_sync(), async () => choose('allow_once'))
    const controller = new AbortController()
    expect(await session.approve(write_request(controller.signal))).toBe(true)
    expect(getEventListeners(controller.signal, 'abort')).toEqual([])
  })

  it('refuses without asking when the turn is cancelled before the client catches up', async () => {
    const cards = create_card_sync()
    cards.start(undefined).record({ kind: 'emit' })
    const ask = vi.fn<PermissionAsker>(async () => choose('allow_once'))
    const session = await manual_session(cards, ask)
    const writes = capture_stderr()
    const controller = new AbortController()
    const answer = Promise.resolve(session.approve(write_request(controller.signal)))
    expect(await has_settled(answer)).toBe(false)
    controller.abort(new Error('cancelled'))
    expect(await answer).toBe(false)
    expect(ask).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('refuses without asking when the turn was cancelled already', async () => {
    const ask = vi.fn<PermissionAsker>(async () => choose('allow_once'))
    const session = await manual_session(create_card_sync(), ask)
    expect(await session.approve(write_request(AbortSignal.abort()))).toBe(false)
    expect(ask).not.toHaveBeenCalled()
  })

  it('refuses at once when the turn is cancelled while the client keeps the request open', async () => {
    const { promise: asked, resolve: on_ask } = Promise.withResolvers<AbortSignal>()
    const session = await manual_session(create_card_sync(), async (_, cancel) => {
      on_ask(cancel)
      return new Promise<RequestPermissionResponse>(() => {})
    })
    const writes = capture_stderr()
    const controller = new AbortController()
    const answer = session.approve(write_request(controller.signal))
    expect(await asked).toBe(controller.signal)
    controller.abort(new Error('cancelled'))
    expect(await answer).toBe(false)
    expect(writes).toEqual([])
  })
})
