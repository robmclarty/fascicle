import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { client } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { describe as describe_flow } from 'fascicle'
import type { TurnRequest } from 'fascicle'
import { acp_agent } from 'fascicle/acp'
import type { AcpTurn } from 'fascicle/acp'
import { keyless_agent, to_messages } from '../examples/acp-agent/main.js'
import { coder_agent, command_env, parse_effort } from '../examples/acp-coder/main.js'
import { run_adversarial_build } from '../examples/adversarial-build/main.js'
import { run_checkpoint_resume } from '../examples/checkpoint-resume/main.js'
import { run_documenter } from '../examples/documenter/main.js'
import { build_review, run_durable_runs } from '../examples/durable-runs/main.js'
import { run_ensemble_judge } from '../examples/ensemble-judge/main.js'
import { run_hello } from '../examples/hello/main.js'
import { run_learn } from '../examples/learn/main.js'
import { run_learn_reviewer } from '../examples/learn-reviewer/main.js'
import { run_object_store } from '../examples/object-store/main.js'
import { run_researcher } from '../examples/researcher/main.js'
import { run_reviewer } from '../examples/reviewer/main.js'
import { run_stdio_agent } from '../examples/stdio-agent/main.js'
import { run_streaming_chat } from '../examples/streaming-chat/main.js'
import { run_suspend_resume } from '../examples/suspend-resume/main.js'
import { run_trajectory_logger } from '../examples/trajectory-logger/main.js'
import { open_session, read_turn } from '../src/acp/test/connect_client.js'
import { scripted_engine } from '../src/acp/test/scripted_provider.js'

describe('examples smoke', () => {
  it('hello reverses the input words and preserves the input string', async () => {
    const { input, output } = await run_hello('the quick brown fox')
    expect(input).toBe('the quick brown fox')
    expect(output).toBe('fox brown quick the')
  })

  it('adversarial_build converges on round 1 with deterministic judges', async () => {
    const result = await run_adversarial_build()
    expect(result.converged).toBe(true)
    expect(result.rounds).toBe(1)
    expect(result.candidate).toBe('candidate(brief-text)')
  })

  it('ensemble_judge returns the highest-confidence verdict and all scores', async () => {
    const result = await run_ensemble_judge()
    expect(result.winner.label).toContain('opus')
    expect(result.scores['opus']).toBe(0.92)
    expect(result.scores['sonnet']).toBe(0.81)
    expect(result.scores['gemini']).toBe(0.74)
  })

  it('stdio_agent synthesizes a headline from two candidate drafts', async () => {
    const result = await run_stdio_agent('flaky tests')
    expect(result.headline).toBe('flaky tests: what actually changed')
    expect(result.candidates).toHaveLength(2)
  })

  it('acp_agent echoes each prompt with its turn number over the wire, keylessly', async () => {
    const { session } = await open_session(await acp_agent(keyless_agent))
    const replies: unknown[] = []
    for (const prompt of ['hello', 'again']) {
      await session.prompt(prompt)
      replies.push(await read_turn(session))
    }
    expect(replies).toEqual(
      ['turn 1: you said "hello"', 'turn 2: you said "again"'].map((text) => ({
        updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }],
        stop_reason: 'end_turn',
      })),
    )
  })

  it('acp_coder writes and runs commands behind permission requests, with the provider keys kept from commands', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'acp-coder-')))
    const command = 'echo "key: ${OPENROUTER_API_KEY:-unset}"'
    const seen: TurnRequest[] = []
    const engine = scripted_engine(
      [
        [{ id: 'w', name: 'write_file', input: { path: 'note.txt', content: 'hello\n' } }],
        [{ id: 'r', name: 'run_command', input: { command } }],
        'wrote note.txt',
        'you are welcome',
      ],
      seen,
    )
    const asked: unknown[] = []
    const client_app = client().onRequest('session/request_permission', (ctx) => {
      asked.push(ctx.params.toolCall.title)
      return { outcome: { outcome: 'selected', optionId: 'allow_once' } }
    })
    const env = command_env({ PATH: process.env['PATH'], OPENROUTER_API_KEY: 'sk-secret', UNSET: undefined })
    const app = await acp_agent(coder_agent({ engine, model: 'script', command_env: env }))
    try {
      const { session } = await open_session(app, { client: client_app, session: { cwd } })
      const stops: unknown[] = []
      for (const prompt of ['write a note, then show the key', 'thanks']) {
        await session.prompt(prompt)
        stops.push((await read_turn(session)).stop_reason)
      }
      expect(stops).toEqual(['end_turn', 'end_turn'])
      expect(asked).toEqual(['Write note.txt', command])
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toBe('hello\n')
      expect(seen[2]?.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('key: unset') })
      expect(seen[0]?.system).toContain(`The workspace root is ${cwd}, and relative paths start there.`)
      expect(seen[0]?.tools.map((tool) => tool.name)).toEqual([
        'read_file',
        'list_files',
        'search',
        'write_file',
        'edit_file',
        'run_command',
      ])
      expect(seen[3]?.messages).toEqual([
        { role: 'user', content: 'write a note, then show the key' },
        { role: 'assistant', content: 'wrote note.txt' },
        { role: 'user', content: 'thanks' },
      ])
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('to_messages tells the model where a cancelled turn stopped', () => {
    const turn = {
      session_id: 's',
      cwd: '/',
      text: 'read the hosts file',
      prompt: [],
      history: [
        { role: 'user', text: 'run sleep 45', cancelled: true },
        { role: 'user', text: 'explain a.ts' },
        { role: 'agent', text: 'It adds', cancelled: true },
      ],
    } satisfies AcpTurn
    const stopped = '[The user stopped this turn here. Leave what it asked for unless they ask again.]'
    expect(to_messages(turn)).toEqual([
      { role: 'user', content: `run sleep 45\n\n${stopped}` },
      { role: 'user', content: 'explain a.ts' },
      { role: 'assistant', content: `It adds\n\n${stopped}` },
      { role: 'user', content: 'read the hosts file' },
    ])
  })

  it('acp_coder keeps every provider key out of the command environment', () => {
    const env = command_env({
      PATH: '/bin',
      OPENROUTER_API_KEY: 'a',
      ANTHROPIC_API_KEY: 'b',
      OPENAI_API_KEY: 'c',
      UNSET: undefined,
    })
    expect(env).toEqual({ PATH: '/bin' })
  })

  it('acp_coder hands --effort to the model call, and leaves the default alone without it', async () => {
    const efforts: unknown[] = []
    for (const effort of [undefined, 'high'] as const) {
      const seen: TurnRequest[] = []
      const engine = scripted_engine(['hi'], seen)
      const config = { engine, model: 'script', command_env: {}, ...(effort === undefined ? {} : { effort }) }
      const { session } = await open_session(await acp_agent(coder_agent(config)))
      await session.prompt('hello')
      await read_turn(session)
      efforts.push(seen[0]?.effort)
    }
    expect(efforts).toEqual(['none', 'high'])
  })

  it('acp_coder refuses an unknown --effort, naming the levels it takes', () => {
    expect(parse_effort(undefined)).toBeUndefined()
    expect(parse_effort('xhigh')).toBe('xhigh')
    expect(() => parse_effort('extreme')).toThrow('unknown effort extreme: use none, low, medium, high, xhigh, max')
  })

  it('streaming_chat surfaces emitted tokens and the final result', async () => {
    const { tokens, result } = await run_streaming_chat()
    expect(tokens).toEqual(['hello', ' ...', ' done'])
    expect(result).toBe('hello ... done')
  })

  it('suspend_resume pauses first, resumes second with the supplied decision', async () => {
    const { suspended, resumed } = await run_suspend_resume()
    expect(suspended).toBe(true)
    expect(resumed).toBe('shipped:beta feature')
  })

  it('durable_runs drives one run across events, one drive at a time', async () => {
    expect(await run_durable_runs()).toEqual({
      opened: 'waiting at ci, deadline in 60 minutes',
      webhook: 'done: posted review of the diff of #42',
      timer: 'busy',
      redelivered: 'done: posted review of the diff of #42',
      drafts: 1,
      replayed: ['gather'],
    })
  })

  it('durable_runs: describe.replays names the step the run replayed, without running anything', () => {
    const flow = build_review({ drafted: () => {}, posting: async () => {} })
    expect(describe_flow.replays(flow)).toEqual([{ id: 'gather', label: 'gather', gates: ['ci'] }])
  })

  it('object_store keeps the whole store contract and holds a durable run in a bucket', async () => {
    expect(await run_object_store()).toEqual({
      conformance: { passed: 32, failed: [], skipped: [] },
      submitted: 'waiting at approve',
      bucket_while_waiting: ['runs/s/exp-7/c/lease', 'runs/s/exp-7/s/flow/v/total', 'runs/s/exp-7/v/record'],
      approved: 'done: reimbursed ada 42.50, approved by grace',
      deleted: true,
      bucket_after_delete: [],
    })
  })

  it('checkpoint_resume runs the inner step once and serves the second call from cache', async () => {
    const { first, second, call_count } = await run_checkpoint_resume()
    expect(first).toBe('index:abc123')
    expect(second).toBe('index:abc123')
    expect(call_count).toBe(1)
  })

  it('trajectory_logger writes JSONL and fans events out to multiple sinks', async () => {
    const { result, span_names, jsonl_line_count } = await run_trajectory_logger()
    expect(result).toBe(11)
    expect(span_names).toContain('sequence')
    expect(jsonl_line_count).toBeGreaterThan(0)
  })

  it('learn reads a synthetic JSONL trajectory and produces analyzer proposals', async () => {
    const { events_considered, run_ids, proposals } = await run_learn()
    expect(events_considered).toBe(5)
    expect(run_ids).toEqual(['run-a', 'run-b'])
    const targets = proposals.map((p) => p.target).toSorted()
    expect(targets).toEqual(['emit', 'span_end', 'span_start'])
  })

  it('reviewer produces parsed findings and a non-empty summary against a stub engine', async () => {
    const { review } = await run_reviewer()
    expect(review.findings.length).toBeGreaterThan(0)
    expect(review.findings[0]?.severity).toBe('major')
    expect(review.summary.length).toBeGreaterThan(0)
  })

  it('documenter returns a parsed { doc, inferred_purpose } against a stub engine', async () => {
    const { result } = await run_documenter()
    expect(result.doc.length).toBeGreaterThan(0)
    expect(result.doc.startsWith('/**')).toBe(true)
    expect(result.inferred_purpose.length).toBeGreaterThan(0)
  })

  it('researcher integrates a single round of search/fetch/summarize against stubs', async () => {
    const { result } = await run_researcher()
    expect(result.brief.length).toBeGreaterThan(0)
    expect(result.sources.length).toBeGreaterThan(0)
    expect(result.sources[0]?.url.startsWith('https://')).toBe(true)
  })

  it('learn_reviewer aggregates reviewer trajectories into prompt-tightening proposals', async () => {
    const { events_considered, run_ids, proposals, per_agent } = await run_learn_reviewer()
    expect(run_ids).toHaveLength(3)
    expect(events_considered).toBeGreaterThan(0)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.target).toBe('reviewer')
    expect(proposals[0]?.kind).toBe('prompt')
    expect(per_agent['reviewer']?.calls).toBe(3)
    expect(per_agent['reviewer']?.input_tokens).toBe(750)
    expect(per_agent['reviewer']?.output_tokens).toBe(270)
  })
})
