import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ClientCapabilities, SessionUpdate } from '@agentclientprotocol/sdk'
import { model_step } from 'fascicle'
import { sequence, step } from '#core'
import type { Step, TrajectoryEvent } from '#core'
import type { Engine, StreamChunk, Tool } from '#engine'
import { json_schema_to_standard } from '#schema'
import { acp_agent } from '../acp_agent.js'
import { create_card_sync } from '../approve.js'
import { prompt_turn } from '../prompt_turn.js'
import { open_session, read_turn } from '../test/connect_client.js'
import { scripted_engine } from '../test/scripted_provider.js'
import type { ScriptedTurn } from '../test/scripted_provider.js'
import { create_acp_mapper_state, to_session_updates } from '../to_session_updates.js'
import { resolve_roots } from '../tools/containment.js'
import { record_preview, reset_previews, take_preview } from '../tools/previews.js'
import type { ToolPreview } from '../tools/previews.js'
import type { AcpSession } from '../types.js'
import { workspace_tools } from '../workspace_tools.js'

/**
 * The fixture, under one scratch directory:
 *
 *   project/        the workspace, reached as `via`, a symlink, so the
 *                   client's terms and the real paths differ
 *     src/a.ts      three lines, only ever read
 *     lib/b.ts      listed and searched
 *   via -> project
 *
 * Each test that writes does so under names of its own.
 */
let base: string
let cwd: string

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'fascicle-acp-presentation-'))
  const project = join(base, 'project')
  await Promise.all([mkdir(join(project, 'src'), { recursive: true }), mkdir(join(project, 'lib'), { recursive: true })])
  await Promise.all([
    writeFile(join(project, 'src', 'a.ts'), 'one\ntwo\nthree\n'),
    writeFile(join(project, 'lib', 'b.ts'), 'export const b = 2\n'),
  ])
  await symlink(project, join(base, 'via'))
  cwd = join(base, 'via')
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

/**
 * The real paths of the fixture's session, made fresh for each test that
 * needs its own store. It runs in Auto, as `wire_turn`'s sessions do, so the
 * writes and commands run without an approval handler.
 */
async function fixture_session(client_capabilities: ClientCapabilities = {}): Promise<AcpSession> {
  const roots = await resolve_roots([cwd])
  return { id: 'session-1', cwd, additional_directories: [], roots, client_capabilities, mode: () => 'auto', approve: () => false }
}

/** A model call on the scripted engine with the session's workspace tools. */
function coder(engine: Engine, session: AcpSession, id = 'coder'): Step<string, string> {
  return model_step({ engine, id, tools: workspace_tools(session) })
}

/**
 * Run one prompt turn of a session whose flow is one model call on
 * `script`, over the wire, and return every update the client was sent.
 */
async function wire_turn(
  script: ReadonlyArray<ScriptedTurn>,
  capabilities: ClientCapabilities = {},
): Promise<ReadonlyArray<SessionUpdate>> {
  const engine = scripted_engine(script)
  const app = await acp_agent({ name: 'presentation', default_mode: 'auto', flow: (session) => coder(engine, session) })
  const { session } = await open_session(app, { client_capabilities: capabilities, session: { cwd } })
  await session.prompt('go')
  const { updates } = await read_turn(session)
  return updates
}

/**
 * The updates for the card whose id ends in `suffix` (the step id, its run,
 * and the raw call id), in order, with that id written as `CARD` so a test
 * can spell them out whatever the turn's id was.
 */
function card(updates: ReadonlyArray<SessionUpdate>, suffix: string): unknown[] {
  const id = (update: SessionUpdate): string => String(Reflect.get(update, 'toolCallId'))
  const opened = updates.find((update) => update.sessionUpdate === 'tool_call' && id(update).endsWith(`:${suffix}`))
  if (opened === undefined) throw new Error(`no card ends in ${suffix}`)
  return updates
    .filter((update) => id(update) === id(opened))
    .map((update): unknown => JSON.parse(JSON.stringify(update).replaceAll(id(opened), 'CARD')))
}

/** The card for a single call `raw` made by the one model call in `wire_turn`. */
function coder_card(updates: ReadonlyArray<SessionUpdate>, raw: string): unknown[] {
  return card(updates, `coder:1:${raw}`)
}

describe('presentation: each workspace tool over the real tool loop', () => {
  it('shows a read with its line range, pointing at the line it starts on', async () => {
    const input = { path: 'src/a.ts', offset: 2, limit: 2 }
    const updates = await wire_turn([[{ id: 'r1', name: 'read_file', input }], 'done'])
    expect(coder_card(updates, 'r1')).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'CARD', title: 'read_file', kind: 'read', status: 'pending' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        status: 'in_progress',
        rawInput: input,
        title: 'Read src/a.ts (2 - 3)',
        locations: [{ path: join(cwd, 'src', 'a.ts'), line: 2 }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        status: 'completed',
        rawOutput: '     2\ttwo\n     3\tthree',
        content: [{ type: 'content', content: { type: 'text', text: '```\n     2\ttwo\n     3\tthree\n```' } }],
      },
    ])
  })

  it('shows a listing as Find with its directory and pattern', async () => {
    const input = { pattern: '**/*.ts', path: 'lib' }
    const updates = await wire_turn([[{ id: 'l1', name: 'list_files', input }], 'done'])
    expect(coder_card(updates, 'l1')).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'CARD', title: 'list_files', kind: 'search', status: 'pending' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        status: 'in_progress',
        rawInput: input,
        title: 'Find `lib` `**/*.ts`',
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        status: 'completed',
        rawOutput: 'lib/b.ts',
        content: [{ type: 'content', content: { type: 'text', text: '```\nlib/b.ts\n```' } }],
      },
    ])
  })

  it('shows a search as the grep command line that would do it', async () => {
    const input = { pattern: 'export', path: 'lib', glob: '*.ts' }
    const updates = await wire_turn([[{ id: 's1', name: 'search', input }], 'done'])
    expect(coder_card(updates, 's1')).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'CARD', title: 'search', kind: 'search', status: 'pending' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        status: 'in_progress',
        rawInput: input,
        title: 'grep --include="*.ts" "export" lib',
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        status: 'completed',
        rawOutput: 'lib/b.ts:1: export const b = 2',
        content: [{ type: 'content', content: { type: 'text', text: '```\nlib/b.ts:1: export const b = 2\n```' } }],
      },
    ])
  })

  it('shows a new file as a diff with no old text', async () => {
    const input = { path: 'src/new.ts', content: 'export const n = 1\n' }
    const updates = await wire_turn([[{ id: 'w1', name: 'write_file', input }], 'done'])
    const path = join(cwd, 'src', 'new.ts')
    expect(coder_card(updates, 'w1')).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'CARD', title: 'write_file', kind: 'edit', status: 'pending' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        status: 'in_progress',
        rawInput: input,
        title: 'Write src/new.ts',
        locations: [{ path }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        status: 'completed',
        rawOutput: 'created src/new.ts',
        content: [{ type: 'diff', path, oldText: null, newText: 'export const n = 1\n' }],
      },
    ])
  })

  it('shows an overwrite as a diff from the old text', async () => {
    await writeFile(join(cwd, 'overwrite.md'), 'old notes\n')
    const updates = await wire_turn([
      [{ id: 'w1', name: 'write_file', input: { path: 'overwrite.md', content: 'new notes\n' } }],
      'done',
    ])
    expect(coder_card(updates, 'w1').at(-1)).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'CARD',
      status: 'completed',
      rawOutput: 'overwrote overwrite.md',
      content: [{ type: 'diff', path: join(cwd, 'overwrite.md'), oldText: 'old notes\n', newText: 'new notes\n' }],
    })
  })

  it('shows an edit as a diff of the whole file, pointing at the line it starts on', async () => {
    await writeFile(join(cwd, 'src', 'edit.ts'), 'a\nb\nc\n')
    const input = { path: 'src/edit.ts', old_text: 'b', new_text: 'B' }
    const updates = await wire_turn([[{ id: 'e1', name: 'edit_file', input }], 'done'])
    const path = join(cwd, 'src', 'edit.ts')
    expect(coder_card(updates, 'e1')).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'CARD', title: 'edit_file', kind: 'edit', status: 'pending' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        status: 'in_progress',
        rawInput: input,
        title: 'Edit src/edit.ts',
        locations: [{ path }],
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        status: 'completed',
        rawOutput: 'edited src/edit.ts at line 2',
        content: [{ type: 'diff', path, oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' }],
        locations: [{ path, line: 2 }],
      },
    ])
  })

  it('shows a refused write as failed, with its error and no diff', async () => {
    const updates = await wire_turn([
      [{ id: 'w1', name: 'write_file', input: { path: '../escape.ts', content: 'x' } }],
      'done',
    ])
    expect(coder_card(updates, 'w1').at(-1)).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'CARD',
      status: 'failed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: `../escape.ts is outside the workspace; the file tools only reach paths under ${cwd}` },
        },
      ],
    })
  })

  it('keeps a tool that is not a workspace tool on the plain card', async () => {
    const engine = scripted_engine([[{ id: 'k1', name: 'lookup', input: { q: 'x' } }], 'done'])
    const lookup: Tool = {
      name: 'lookup',
      description: 'Look something up',
      input_schema: json_schema_to_standard({ type: 'object' }),
      execute: () => 'found',
    }
    const app = await acp_agent({
      name: 'presentation',
      flow: () => model_step({ engine, id: 'coder', tools: [lookup] }),
    })
    const { session } = await open_session(app, { session: { cwd } })
    await session.prompt('go')
    const { updates } = await read_turn(session)
    expect(coder_card(updates, 'k1')).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'CARD', title: 'lookup', kind: 'other', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'CARD', status: 'in_progress', rawInput: { q: 'x' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'CARD', status: 'completed', rawOutput: 'found' },
    ])
  })
})

describe('presentation: command output', () => {
  const terminal_client: ClientCapabilities = { _meta: { terminal_output: true } }

  it('shows the output as a console block, exit code included, to a client without terminals', async () => {
    const input = { command: 'echo hi' }
    const updates = await wire_turn([[{ id: 'c1', name: 'run_command', input }], 'done'])
    expect(coder_card(updates, 'c1')).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 'CARD', title: 'run_command', kind: 'execute', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'CARD', status: 'in_progress', rawInput: input, title: 'echo hi' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        status: 'completed',
        rawOutput: 'hi\n[exit code 0]',
        content: [{ type: 'content', content: { type: 'text', text: '```console\nhi\n[exit code 0]\n```' } }],
      },
    ])
  })

  it('keeps a failed command error as the card text for a client without terminals', async () => {
    const input = { command: 'sleep 5', timeout_ms: 50 }
    const updates = await wire_turn([[{ id: 'c1', name: 'run_command', input }], 'done'])
    const closing = coder_card(updates, 'c1').at(-1)
    expect(closing).toMatchObject({ status: 'failed' })
    expect(JSON.stringify(closing)).toContain("the command didn't finish within 0.05 s")
    expect(JSON.stringify(closing)).not.toContain('```console')
  })

  it('streams the output to the terminal the card opened with, then its exit', async () => {
    const input = { command: 'echo hi' }
    const updates = await wire_turn([[{ id: 'c1', name: 'run_command', input }], 'done'], terminal_client)
    expect(coder_card(updates, 'c1')).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'CARD',
        title: 'run_command',
        kind: 'execute',
        status: 'pending',
        content: [{ type: 'terminal', terminalId: 'CARD' }],
        _meta: { terminal_info: { terminal_id: 'CARD' } },
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'CARD', status: 'in_progress', rawInput: input, title: 'echo hi' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        _meta: { terminal_output: { terminal_id: 'CARD', data: 'hi' } },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'CARD',
        status: 'completed',
        rawOutput: 'hi\n[exit code 0]',
        content: [{ type: 'terminal', terminalId: 'CARD' }],
        _meta: { terminal_exit: { terminal_id: 'CARD', exit_code: 0, signal: null } },
      },
    ])
  })

  it.each([
    ['a non-zero exit', 'echo oops >&2; exit 3', { data: 'oops', exit_code: 3, signal: null }],
    ['a command that printed nothing', 'true', { data: '', exit_code: 0, signal: null }],
    ['a command ended by a signal', 'kill -TERM $$', { data: '', exit_code: null, signal: 'SIGTERM' }],
  ])('ends the terminal with %s', async (_label, command, expected) => {
    const updates = await wire_turn([[{ id: 'c1', name: 'run_command', input: { command } }], 'done'], terminal_client)
    const [output, closing] = coder_card(updates, 'c1').slice(-2)
    expect(output).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'CARD',
      _meta: { terminal_output: { terminal_id: 'CARD', data: expected.data } },
    })
    expect(closing).toMatchObject({
      status: 'completed',
      _meta: { terminal_exit: { terminal_id: 'CARD', exit_code: expected.exit_code, signal: expected.signal } },
    })
  })

  it('sends the terminal output as the model read it, cut marker included', async () => {
    const updates = await wire_turn(
      [[{ id: 'c1', name: 'run_command', input: { command: "printf '%032001d' 0" } }], 'done'],
      terminal_client,
    )
    expect(coder_card(updates, 'c1').at(-2)).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'CARD',
      _meta: {
        terminal_output: {
          terminal_id: 'CARD',
          data: `${'0'.repeat(32_000)}\n[output cut at 32000 bytes of 32001; pipe the command through tail, head, or grep to see the part you need]`,
        },
      },
    })
  })

  it('shows a failed command error on its terminal, with no exit code', async () => {
    const input = { command: 'sleep 5', timeout_ms: 50 }
    const updates = await wire_turn([[{ id: 'c1', name: 'run_command', input }], 'done'], terminal_client)
    const [output, closing] = coder_card(updates, 'c1').slice(-2)
    expect(output).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'CARD',
      _meta: {
        terminal_output: { terminal_id: 'CARD', data: expect.stringMatching(/^the command didn't finish within 0\.05 s/) },
      },
    })
    expect(closing).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'CARD',
      status: 'failed',
      content: [{ type: 'terminal', terminalId: 'CARD' }],
      _meta: { terminal_exit: { terminal_id: 'CARD', exit_code: null, signal: null } },
    })
  })
})

describe('presentation: previews that share a raw id', () => {
  /**
   * Run one prompt turn of `flow` through `prompt_turn`, holding every send
   * until the run has finished, so each tool has run and left its preview
   * before the mapper reaches the first result: the most a consumer can
   * fall behind.
   */
  async function slow_turn(session: AcpSession, build: (release: Step<string, string>) => Step<string, string>): Promise<SessionUpdate[]> {
    const { promise: finished, resolve: finish } = Promise.withResolvers<void>()
    const release = step('release', (text: string) => {
      finish()
      return text
    })
    const updates: SessionUpdate[] = []
    const send = async (update: SessionUpdate): Promise<void> => {
      await finished
      updates.push(update)
    }
    const record = { session, flow: build(release), history: [], cards: create_card_sync(), last_turn: null }
    await prompt_turn({ name: 'presentation', flow: record.flow }, record, [{ type: 'text', text: 'go' }], new AbortController().signal, send)
    return updates
  }

  /** The closing update of a card in a `slow_turn`. */
  function closing(updates: ReadonlyArray<SessionUpdate>, suffix: string): unknown {
    return card(updates, suffix).at(-1)
  }

  it('gives each of two calls sharing a raw id its own diff', async () => {
    await mkdir(join(cwd, 'pair'), { recursive: true })
    await writeFile(join(cwd, 'pair', 'two.ts'), 'two\n')
    const session = await fixture_session()
    const engine = scripted_engine([
      [{ id: 'ollama_call_0_0', name: 'write_file', input: { path: 'pair/one.ts', content: 'one\n' } }],
      'first done',
      [{ id: 'ollama_call_0_0', name: 'edit_file', input: { path: 'pair/two.ts', old_text: 'two', new_text: 'TWO' } }],
      'second done',
    ])
    const updates = await slow_turn(session, (release) =>
      sequence([coder(engine, session, 'first'), coder(engine, session, 'second'), release]),
    )
    expect(closing(updates, 'first:1:ollama_call_0_0')).toMatchObject({
      content: [{ type: 'diff', path: join(cwd, 'pair', 'one.ts'), oldText: null, newText: 'one\n' }],
    })
    expect(closing(updates, 'second:1:ollama_call_0_0')).toMatchObject({
      content: [{ type: 'diff', path: join(cwd, 'pair', 'two.ts'), oldText: 'two\n', newText: 'TWO\n' }],
      locations: [{ path: join(cwd, 'pair', 'two.ts'), line: 1 }],
    })
  })

  it("never lets a call that failed take a later call's preview", async () => {
    const session = await fixture_session()
    const engine = scripted_engine([
      [{ id: 'ollama_call_0_0', name: 'write_file', input: { path: '../escape.ts', content: 'x' } }],
      'first done',
      [{ id: 'ollama_call_0_0', name: 'write_file', input: { path: 'pair/three.ts', content: 'three\n' } }],
      'second done',
    ])
    const updates = await slow_turn(session, (release) =>
      sequence([coder(engine, session, 'first'), coder(engine, session, 'second'), release]),
    )
    expect(closing(updates, 'first:1:ollama_call_0_0')).toMatchObject({ status: 'failed' })
    expect(JSON.stringify(closing(updates, 'first:1:ollama_call_0_0'))).not.toContain('diff')
    expect(closing(updates, 'second:1:ollama_call_0_0')).toMatchObject({
      content: [{ type: 'diff', path: join(cwd, 'pair', 'three.ts'), oldText: null, newText: 'three\n' }],
    })
  })

  it('starts each turn with an empty store, so an earlier turn cannot hand over a preview', async () => {
    const session = await fixture_session()
    record_preview(session, 'w1', { kind: 'change', path: '/stale.ts', old_text: null, new_text: 'stale', line: undefined })
    const engine = scripted_engine([[{ id: 'w1', name: 'write_file', input: { path: 'pair/four.ts', content: 'four\n' } }], 'done'])
    const updates = await slow_turn(session, (release) => sequence([coder(engine, session), release]))
    expect(closing(updates, 'coder:1:w1')).toMatchObject({
      content: [{ type: 'diff', path: join(cwd, 'pair', 'four.ts'), oldText: null, newText: 'four\n' }],
    })
  })
})

describe('presentation: titles and locations', () => {
  const session: AcpSession = {
    id: 's',
    cwd: '/work',
    additional_directories: ['/shared'],
    roots: ['/work', '/shared'],
    client_capabilities: {},
    mode: () => 'manual',
    approve: () => false,
  }

  function model_chunk(chunk: StreamChunk): TrajectoryEvent {
    return { kind: 'model_chunk', step_id: 'm', chunk }
  }

  /** The update a call's complete input sends, for a call to `name` in a turn with `over` as its session. */
  function input_update(name: string, input: unknown): SessionUpdate | undefined {
    const state = create_acp_mapper_state({ turn_id: 't', session })
    to_session_updates(model_chunk({ kind: 'tool_call_start', id: 'c1', name, step_index: 0 }), state)
    return to_session_updates(model_chunk({ kind: 'tool_call_end', id: 'c1', input, step_index: 0 }), state)[0]
  }

  it.each([
    ['an offset and a limit', { path: 'src/a.ts', offset: 5, limit: 10 }, 'Read src/a.ts (5 - 14)', 5],
    ['a limit alone', { path: 'src/a.ts', limit: 10 }, 'Read src/a.ts (1 - 10)', 1],
    ['an offset alone', { path: 'src/a.ts', offset: 7 }, 'Read src/a.ts (from line 7)', 7],
    ['neither', { path: './src/../src/a.ts' }, 'Read src/a.ts', 1],
  ])('titles a read with %s', (_label, input, title, line) => {
    expect(input_update('read_file', input)).toMatchObject({ title, locations: [{ path: '/work/src/a.ts', line }] })
  })

  it('shows a path under cwd relative to it, and any other absolute', () => {
    expect(input_update('write_file', { path: '/work/src/a.ts', content: '' })).toMatchObject({
      title: 'Write src/a.ts',
      locations: [{ path: '/work/src/a.ts' }],
    })
    expect(input_update('edit_file', { path: '/shared/b.ts', old_text: 'x', new_text: 'y' })).toMatchObject({
      title: 'Edit /shared/b.ts',
      locations: [{ path: '/shared/b.ts' }],
    })
  })

  it.each([
    ['list_files', {}, 'Find'],
    ['list_files', { path: '.' }, 'Find `.`'],
    ['list_files', { pattern: '*.md' }, 'Find `*.md`'],
    ['search', { pattern: 'todo' }, 'grep "todo"'],
    ['search', { pattern: 'todo', path: '/work/src', glob: 'src/**/*.ts' }, 'grep --include="src/**/*.ts" "todo" src'],
    ['search', {}, 'grep'],
    ['run_command', { command: 'pnpm test' }, 'pnpm test'],
  ])('titles %s with %j as %s, with no locations', (name, input, title) => {
    const update = input_update(name, input)
    expect(update).toMatchObject({ title })
    expect(update).not.toHaveProperty('locations')
  })

  it.each([
    ['read_file', { offset: 2 }],
    ['write_file', { content: 'x' }],
    ['edit_file', null],
    ['run_command', 'ls'],
  ])('leaves the card as it opened when %s gets %j', (name, input) => {
    expect(input_update(name, input)).toStrictEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't:m:0:c1',
      status: 'in_progress',
      rawInput: input,
    })
  })

  it('gives every tool the plain card when the state has no session', () => {
    const state = create_acp_mapper_state({ turn_id: 't' })
    const chunks: StreamChunk[] = [
      { kind: 'tool_call_start', id: 'c1', name: 'run_command', step_index: 0 },
      { kind: 'tool_call_end', id: 'c1', input: { command: 'ls' }, step_index: 0 },
      { kind: 'tool_result', id: 'c1', output: 'a.ts', step_index: 0 },
    ]
    expect(chunks.flatMap((chunk) => to_session_updates(model_chunk(chunk), state))).toEqual([
      { sessionUpdate: 'tool_call', toolCallId: 't:m:0:c1', title: 'run_command', kind: 'other', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 't:m:0:c1', status: 'in_progress', rawInput: { command: 'ls' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 't:m:0:c1', status: 'completed', rawOutput: 'a.ts' },
    ])
  })

  it('opens no terminal for a tool that runs no command, whatever the client draws', () => {
    const state = create_acp_mapper_state({
      turn_id: 't',
      session: { ...session, client_capabilities: { _meta: { terminal_output: true } } },
    })
    const opened = to_session_updates(model_chunk({ kind: 'tool_call_start', id: 'c1', name: 'read_file', step_index: 0 }), state)
    expect(opened).toEqual([{ sessionUpdate: 'tool_call', toolCallId: 't:m:0:c1', title: 'read_file', kind: 'read', status: 'pending' }])
  })

  it('presents nothing for a call whose card it never saw open', () => {
    const state = create_acp_mapper_state({ turn_id: 't', session })
    const update = to_session_updates(
      model_chunk({ kind: 'tool_call_end', id: 'c1', input: { path: 'a.ts' }, step_index: 0 }),
      state,
    )
    expect(update).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 't:m:0:c1', status: 'in_progress', rawInput: { path: 'a.ts' } },
    ])
  })
})

describe('presentation: closing a card from the mapper', () => {
  const session: AcpSession = {
    id: 's',
    cwd: '/work',
    additional_directories: [],
    roots: ['/work'],
    client_capabilities: {},
    mode: () => 'manual',
    approve: () => false,
  }
  const terminals: AcpSession = { ...session, id: 't', client_capabilities: { _meta: { terminal_output: true } } }

  function model_chunk(chunk: StreamChunk): TrajectoryEvent {
    return { kind: 'model_chunk', step_id: 'm', chunk }
  }

  /** Open a card for `name` under raw id `id`, then map its result. */
  function close(over: AcpSession, name: string, id: string, result: { output?: unknown; error?: { message: string } }): SessionUpdate[] {
    const state = create_acp_mapper_state({ turn_id: 't', session: over })
    to_session_updates(model_chunk({ kind: 'tool_call_start', id, name, step_index: 0 }), state)
    return to_session_updates(model_chunk({ kind: 'tool_result', id, step_index: 0, ...result }), state)
  }

  it.each([
    ['no fence of its own', 'ok', '```'],
    ['a fence inside a line', 'see ``` here', '```'],
    ['a fence opening a line', 'a\n```\nb', '````'],
    ['a longer fence opening a line', '`````', '``````'],
  ])('fences a console block around output with %s', (_label, output, fence) => {
    const [update] = close(session, 'run_command', 'c1', { output })
    expect(update).toMatchObject({
      content: [{ type: 'content', content: { type: 'text', text: `${fence}console\n${output}\n${fence}` } }],
    })
  })

  it.each(['read_file', 'list_files', 'search'])(
    'puts what %s returned on its card in a code block whose fence outruns the text, keeping rawOutput',
    (name) => {
      const output = 'src/a.ts:1: *a*\n```\nsrc/a.ts:3: # b'
      expect(close(session, name, 'r1', { output })).toEqual([
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't:m:0:r1',
          status: 'completed',
          rawOutput: output,
          content: [{ type: 'content', content: { type: 'text', text: `\`\`\`\`\n${output}\n\`\`\`\`` } }],
        },
      ])
    },
  )

  it.each(['read_file', 'list_files', 'search'])('keeps the error text on a failed %s card', (name) => {
    expect(close(session, name, 'r1', { error: { message: "src/a.ts doesn't exist" } })).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't:m:0:r1',
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: "src/a.ts doesn't exist" } }],
      },
    ])
  })

  it('ends a terminal with no output when the command left no preview', () => {
    expect(close(terminals, 'run_command', 'c1', { output: 'from elsewhere' })[0]).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't:m:0:c1',
      _meta: { terminal_output: { terminal_id: 't:m:0:c1', data: '' } },
    })
  })

  it('closes a write that left no preview as it stands', () => {
    expect(close(session, 'write_file', 'w1', { output: 'created a.ts' })).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 't:m:0:w1', status: 'completed', rawOutput: 'created a.ts' },
    ])
  })

  it('takes a preview only for the successful result of a tool that leaves one', () => {
    const preview: ToolPreview = { kind: 'change', path: '/work/a.ts', old_text: null, new_text: 'a', line: undefined }
    reset_previews(session)
    record_preview(session, 'x', preview)
    close(session, 'read_file', 'x', { output: 'read' })
    close(session, 'write_file', 'x', { error: { message: 'refused' } })
    close(session, 'lookup', 'x', { output: 'found' })
    expect(take_preview(session, 'x')).toBe(preview)
  })

  it('closes a write with a command preview as it stands', () => {
    reset_previews(session)
    record_preview(session, 'w1', { kind: 'command', output: 'x', exit_code: 0, signal: null })
    expect(close(session, 'write_file', 'w1', { output: 'created a.ts' })).toEqual([
      { sessionUpdate: 'tool_call_update', toolCallId: 't:m:0:w1', status: 'completed', rawOutput: 'created a.ts' },
    ])
  })
})

describe('presentation: the preview store', () => {
  const change = (new_text: string): ToolPreview => ({ kind: 'change', path: '/a', old_text: null, new_text, line: undefined })
  const bare = (id: string): AcpSession => ({
    id,
    cwd: '/a',
    additional_directories: [],
    roots: ['/a'],
    client_capabilities: {},
    mode: () => 'manual',
    approve: () => false,
  })

  it('hands back a raw id previews oldest first, and nothing once they are gone', () => {
    const session = bare('q')
    record_preview(session, 'x', change('1'))
    record_preview(session, 'x', change('2'))
    record_preview(session, 'y', change('3'))
    expect([take_preview(session, 'x'), take_preview(session, 'x'), take_preview(session, 'x')]).toEqual([
      change('1'),
      change('2'),
      undefined,
    ])
    expect(take_preview(session, 'y')).toEqual(change('3'))
  })

  it('keeps each session to its own store, and empties one on reset', () => {
    const a = bare('a')
    const b = bare('b')
    record_preview(a, 'x', change('a'))
    record_preview(b, 'x', change('b'))
    reset_previews(a)
    expect(take_preview(a, 'x')).toBeUndefined()
    expect(take_preview(b, 'x')).toEqual(change('b'))
  })
})
