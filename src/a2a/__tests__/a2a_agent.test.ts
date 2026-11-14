import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryTaskStore } from '@a2a-js/sdk/server'
import { memory_store, sqlite_store } from '#adapters'
import { durable, sequence, step } from '#core'
import type { DurableRuns, TrajectoryEvent } from '#core'
import { a2a_agent } from '../a2a_agent.js'
import { data_part, text_part } from '../parts.js'
import { sqlite_task_store } from '../sqlite_task_store.js'
import { to_task_events } from '../to_task_events.js'
import type { A2aAgent, A2aTurn } from '../types.js'
import { approval, CARD, gated_flow, latched, say, speaker } from './support/flows.js'
import {
  artifact_texts,
  call,
  get_task,
  parts_text,
  send,
  state_of,
  status_text,
  stream,
  task_in,
  parts_in,
  user_message,
} from './support/rpc.js'

type Json = Record<string, unknown>

const agents: A2aAgent[] = []
const dirs: string[] = []
const closers: Array<() => void> = []

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()))
  vi.restoreAllMocks()
})

afterAll(() => {
  for (const close of closers) close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// Build an agent that the suite closes once the test is over.
async function agent_for(config: Parameters<typeof a2a_agent<string, unknown>>[0]): Promise<A2aAgent> {
  const agent = await a2a_agent(config)
  agents.push(agent)
  return agent
}

function fresh_runs(): DurableRuns {
  return durable({ store: memory_store() })
}

const id_of = (task: Json): string => task['id'] as string
const history_of = (task: Json): Json[] => (task['history'] ?? []) as Json[]
const artifacts_of = (task: Json): Json[] => (task['artifacts'] ?? []) as Json[]
const status_message = (task: Json): Json => (task['status'] as Json)['message'] as Json

describe('a2a_agent: a task that runs to the end', () => {
  it('completes a blocking SendMessage with the output as its artifact, and deletes the run', async () => {
    const runs = fresh_runs()
    const agent = await agent_for({ flow: step('echo', (text: string) => `echo: ${text}`), card: CARD, runs })

    const task = await send(agent, 'hello')

    expect(state_of(task)).toBe('TASK_STATE_COMPLETED')
    expect(artifact_texts(task)).toEqual(['echo: hello'])
    expect(history_of(task).map((message) => message['role'])).toEqual(['ROLE_USER'])
    expect(parts_text(history_of(task)[0]?.['parts'])).toBe('hello')
    expect(await runs.get(id_of(task))).toBeUndefined()
    expect(state_of(await get_task(agent, id_of(task)))).toBe('TASK_STATE_COMPLETED')
  })

  it('sends a structured output as a data part, and nothing for a flow that returns nothing', async () => {
    const structured = await agent_for({ flow: step('score', () => ({ score: 3 })), card: CARD })
    const task = await send(structured, 'rate this')
    expect(artifacts_of(task)).toHaveLength(1)
    expect(parts_in(artifacts_of(task)[0])[0]).toMatchObject({ data: { score: 3 } })

    const silent = await agent_for({ flow: step('silent', () => undefined), card: CARD })
    const quiet = await send(silent, 'anything')
    expect(state_of(quiet)).toBe('TASK_STATE_COMPLETED')
    expect(artifacts_of(quiet)).toEqual([])
  })

  it('maps the turn to the flow input with to_input, and the output to parts with to_parts', async () => {
    const turns: A2aTurn[] = []
    const agent = await a2a_agent({
      flow: step('count', (input: { words: number }) => input.words * 2),
      card: CARD,
      to_input: (turn) => {
        turns.push(turn)
        return { words: turn.text.split(' ').length }
      },
      to_parts: (doubled) => [text_part(`doubled to ${doubled}`)],
    })
    agents.push(agent)

    const task = await send(agent, 'one two three', { data: { extra: true } })

    expect(artifact_texts(task)).toEqual(['doubled to 6'])
    expect(turns[0]).toMatchObject({
      task_id: id_of(task),
      context_id: task['contextId'],
      text: 'one two three',
      data: [{ extra: true }],
      files: [],
      history: [],
      user: { name: '', authenticated: false },
    })
    expect(turns[0]?.message.parts).toHaveLength(2)
  })

  it('hands file parts to the flow as sent, bytes as base64 and a url as a url', async () => {
    const seen: A2aTurn[] = []
    const agent = await a2a_agent({
      flow: step('files', (n: number) => n),
      card: CARD,
      to_input: (turn) => {
        seen.push(turn)
        return turn.files.length
      },
    })
    agents.push(agent)
    const message = {
      ...user_message('see attached'),
      parts: [
        { text: 'see attached' },
        { raw: Buffer.from('bytes').toString('base64'), filename: 'a.bin', mediaType: 'application/octet-stream' },
        { url: 'https://example.test/b.pdf', filename: 'b.pdf', mediaType: 'application/pdf' },
      ],
    }
    await call(agent, 'SendMessage', { message })
    expect(seen[0]?.files).toEqual([
      { filename: 'a.bin', media_type: 'application/octet-stream', base64: Buffer.from('bytes').toString('base64') },
      { filename: 'b.pdf', media_type: 'application/pdf', url: 'https://example.test/b.pdf' },
    ])
  })

  it('returns at once with returnImmediately, and finishes the task behind the answer', async () => {
    const { flow, latch } = latched()
    const agent = await agent_for({ flow, card: CARD })

    const { result } = await call(agent, 'SendMessage', {
      message: user_message('go'),
      configuration: { returnImmediately: true },
    })
    const task = task_in({ result, error: undefined })
    expect(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']).toContain(state_of(task))

    await latch.started
    latch.open('finished')
    await vi.waitFor(async () => {
      expect(state_of(await get_task(agent, id_of(task)))).toBe('TASK_STATE_COMPLETED')
    })
    expect(artifact_texts(await get_task(agent, id_of(task)))).toEqual(['go: finished'])
  })
})

describe('a2a_agent: a task that fails', () => {
  it('ends FAILED with the error message, and deletes the run', async () => {
    const runs = fresh_runs()
    const flow = step('boom', (): string => {
      throw new Error('the database is on fire')
    })
    const agent = await agent_for({ flow, card: CARD, runs })

    const task = await send(agent, 'go')

    expect(state_of(task)).toBe('TASK_STATE_FAILED')
    expect(status_text(task)).toBe('the database is on fire')
    expect(await runs.get(id_of(task))).toBeUndefined()
  })

  it('lets to_failure replace a message that should not leave the server', async () => {
    const seen: unknown[] = []
    const flow = step('boom', (): string => {
      throw new Error('postgres://admin:hunter2@db.internal refused the connection')
    })
    const agent = await agent_for({
      flow,
      card: CARD,
      to_failure: (err) => {
        seen.push(err)
        return 'The agent could not finish the task.'
      },
    })

    const task = await send(agent, 'go')

    expect(status_text(task)).toBe('The agent could not finish the task.')
    expect(JSON.stringify(task)).not.toContain('hunter2')
    expect(seen[0]).toBeInstanceOf(Error)
  })

  it('fails the task when to_input throws, before any run starts', async () => {
    const runs = fresh_runs()
    const agent = await a2a_agent({
      flow: step('never', (n: number) => n),
      card: CARD,
      runs,
      to_input: () => {
        throw new Error('the message has no number in it')
      },
    })
    agents.push(agent)
    const task = await send(agent, 'go')
    expect(state_of(task)).toBe('TASK_STATE_FAILED')
    expect(status_text(task)).toBe('the message has no number in it')
  })
})

describe('a2a_agent: streaming', () => {
  it('answers SendStreamingMessage with the task, WORKING, each chunk, and COMPLETED, in order', async () => {
    const agent = await agent_for({ flow: speaker('write', ['Release ', 'notes ', 'done.']), card: CARD })

    const frames = await stream(agent, 'SendStreamingMessage', { message: user_message('v1.2') })

    expect(frames.map((frame) => Object.keys(frame)[0])).toEqual([
      'task',
      'statusUpdate',
      'artifactUpdate',
      'artifactUpdate',
      'artifactUpdate',
      'statusUpdate',
    ])
    expect(state_of(frames[0]?.['task'] as Json)).toBe('TASK_STATE_SUBMITTED')
    expect(state_of(frames[1]?.['statusUpdate'] as Json)).toBe('TASK_STATE_WORKING')
    const chunks = frames.slice(2, 5).map((frame) => frame['artifactUpdate'] as Json)
    expect(chunks.map((chunk) => parts_text((chunk['artifact'] as Json)['parts']))).toEqual([
      'Release ',
      'notes ',
      'done.',
    ])
    expect(chunks.map((chunk) => chunk['append'] ?? false)).toEqual([false, true, true])
    expect(chunks.map((chunk) => chunk['lastChunk'] ?? false)).toEqual([false, false, true])
    expect(new Set(chunks.map((chunk) => (chunk['artifact'] as Json)['artifactId'])).size).toBe(1)
    expect(state_of(frames[5]?.['statusUpdate'] as Json)).toBe('TASK_STATE_COMPLETED')
  })

  it('folds the same chunks into the task a blocking SendMessage returns, without repeating the output', async () => {
    const agent = await agent_for({ flow: speaker('write', ['Release ', 'notes.']), card: CARD })
    const task = await send(agent, 'v1.2')
    expect(artifact_texts(task)).toEqual(['Release notes.'])
  })

  it('puts a structured output behind the streamed text, in the same artifact', async () => {
    const flow = sequence([speaker('write', ['prose ', 'here']), step('rate', (prose: string) => ({ words: prose.split(' ').length }))])
    const agent = await agent_for({ flow, card: CARD })

    const frames = await stream(agent, 'SendStreamingMessage', { message: user_message('go') })
    const updates = frames.flatMap((frame) => (frame['artifactUpdate'] === undefined ? [] : [frame['artifactUpdate'] as Json]))

    expect(updates).toHaveLength(2)
    expect(parts_in(updates[1]?.['artifact'])).toMatchObject([{ text: 'here' }, { data: { words: 2 } }])
    expect(updates[1]).toMatchObject({ append: true, lastChunk: true })
  })

  it('routes a call to none with stream, so only the calls beside it reach the artifact', async () => {
    const flow = sequence([speaker('plan', ['{"steps":[]}']), speaker('write', ['the prose'])])
    const agent = await agent_for({ flow, card: CARD, stream: (id) => (id === 'plan' ? 'none' : 'artifact') })
    const task = await send(agent, 'go')
    expect(artifact_texts(task)).toEqual(['the prose'])
  })

  it('maps every run event through to_events, which can add to what the default returns', async () => {
    const kinds: string[] = []
    const agent = await agent_for({
      flow: speaker('write', ['text']),
      card: CARD,
      to_events: (event, state) => {
        kinds.push(event.kind)
        return to_task_events(event, state)
      },
    })
    const task = await send(agent, 'go')
    expect(artifact_texts(task)).toEqual(['text'])
    expect(kinds).toEqual(expect.arrayContaining(['span_start', 'model_chunk', 'span_end', 'run_end']))
  })

  it('hands every drive event to the config trajectory logger as well', async () => {
    const events: TrajectoryEvent[] = []
    const spans: string[] = []
    const agent = await agent_for({
      flow: speaker('write', ['text']),
      card: CARD,
      trajectory: {
        record: (event) => events.push(event),
        start_span: (name) => {
          spans.push(`start:${name}`)
          return `mine:${name}`
        },
        end_span: (span_id) => {
          spans.push(`end:${span_id}`)
        },
      },
    })
    await send(agent, 'go')
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(['flow_structure', 'model_chunk', 'run_end']))
    expect(spans).toEqual(['start:step', 'end:mine:step'])
  })
})

describe('a2a_agent: a client gate', () => {
  it('stops INPUT_REQUIRED with the question, then completes on the answer', async () => {
    const runs = fresh_runs()
    const drafts = { n: 0 }
    const agent = await agent_for({ flow: gated_flow(drafts), card: CARD, runs })

    const waiting = await send(agent, 'v1.2')

    expect(state_of(waiting)).toBe('TASK_STATE_INPUT_REQUIRED')
    const question = status_message(waiting)
    expect(question['role']).toBe('ROLE_AGENT')
    expect(question['parts']).toMatchObject([
      { text: 'Waiting for input at "approve".' },
      { data: { input: 'notes on v1.2' } },
    ])
    expect(question['metadata']).toEqual({ fascicle: { gate: 'approve' } })
    expect(await runs.get(id_of(waiting))).toMatchObject({ kind: 'suspended', id: 'approve' })

    const done = await send(agent, '', { task_id: id_of(waiting), data: { approved: true } })

    expect(state_of(done)).toBe('TASK_STATE_COMPLETED')
    expect(artifact_texts(done)).toEqual(['published: notes on v1.2 [approved]'])
    expect(history_of(done).map((message) => message['role'])).toEqual(['ROLE_USER', 'ROLE_AGENT', 'ROLE_USER'])
    expect(await runs.get(id_of(waiting))).toBeUndefined()
    expect(drafts.n).toBe(2)
  })

  it('carries the gate deadline in the status message metadata', async () => {
    const agent = await agent_for({ flow: approval('approve', 60_000), card: CARD })
    const before = Date.now()
    const waiting = await send(agent, 'draft')
    const gate = (status_message(waiting)['metadata'] as Json)['fascicle'] as Json
    expect(gate['gate']).toBe('approve')
    expect(gate['deadline_at']).toBeGreaterThanOrEqual(before + 60_000)
    expect(gate['deadline_at']).toBeLessThanOrEqual(Date.now() + 60_000)
  })

  it('asks what to_question says, as text or as parts', async () => {
    const as_text = await agent_for({
      flow: gated_flow(),
      card: CARD,
      to_question: (gate, payload) => `Approve ${JSON.stringify((payload as { input: string }).input)} at ${gate}?`,
    })
    expect(status_message(await send(as_text, 'v1'))['parts']).toMatchObject([{ text: 'Approve "notes on v1" at approve?' }])

    const as_parts = await agent_for({
      flow: gated_flow(),
      card: CARD,
      to_question: () => [text_part('Yes or no?'), data_part({ choices: ['yes', 'no'] })],
    })
    expect(status_message(await send(as_parts, 'v1'))['parts']).toMatchObject([
      { text: 'Yes or no?' },
      { data: { choices: ['yes', 'no'] } },
    ])
  })

  it('takes the text as the answer when the message has no data, and to_resume when given', async () => {
    const answers: unknown[] = []
    const flow = approval()
    const by_text = await agent_for({ flow, card: CARD })
    const refused = await send(by_text, 'yes', { task_id: id_of(await send(by_text, 'draft')) })
    expect(state_of(refused)).toBe('TASK_STATE_INPUT_REQUIRED')

    const mapped = await agent_for({
      flow,
      card: CARD,
      to_resume: (turn, gate) => {
        answers.push([turn.text, gate])
        return { approved: turn.text === 'yes' }
      },
    })
    const done = await send(mapped, 'yes', { task_id: id_of(await send(mapped, 'draft')) })
    expect(state_of(done)).toBe('TASK_STATE_COMPLETED')
    expect(artifact_texts(done)).toEqual(['draft [approved]'])
    expect(answers).toEqual([['yes', 'approve']])
  })

  it('leaves the task waiting, with the issues, when the gate refuses the answer', async () => {
    const runs = fresh_runs()
    const agent = await agent_for({ flow: gated_flow(), card: CARD, runs })
    const waiting = await send(agent, 'v1.2')

    const refused = await send(agent, '', { task_id: id_of(waiting), data: { approved: 'maybe' } })

    expect(state_of(refused)).toBe('TASK_STATE_INPUT_REQUIRED')
    expect(status_text(refused)).toMatch(/^The answer to "approve" was refused: approved: /)
    expect(status_message(refused)['metadata']).toEqual({ fascicle: { gate: 'approve' } })
    expect(await runs.get(id_of(waiting))).toMatchObject({ kind: 'suspended', id: 'approve' })

    const done = await send(agent, '', { task_id: id_of(waiting), data: { approved: false } })
    expect(state_of(done)).toBe('TASK_STATE_COMPLETED')
    expect(artifact_texts(done)).toEqual(['published: notes on v1.2 [refused]'])
  })

  it('streams each drive into an artifact of its own, and stays quiet about a step that replays', async () => {
    const flow = sequence([speaker('draft', ['the ', 'draft']), approval(), speaker('publish', ['published'])])
    const agent = await agent_for({ flow, card: CARD })

    const first = await stream(agent, 'SendStreamingMessage', { message: user_message('v1') })
    const task_id = id_of(first[0]?.['task'] as Json)
    expect(state_of(first.at(-1)?.['statusUpdate'] as Json)).toBe('TASK_STATE_INPUT_REQUIRED')

    const second = await stream(agent, 'SendStreamingMessage', {
      message: user_message('', { task_id, data: { approved: true } }),
    })
    const texts = second.flatMap((frame) => {
      const update = frame['artifactUpdate'] as Json | undefined
      return update === undefined ? [] : [parts_text((update['artifact'] as Json)['parts'])]
    })
    expect(texts).toEqual(['published'])

    const task = await get_task(agent, task_id)
    expect(artifact_texts(task)).toEqual(['the draft', 'published'])
    expect(new Set(artifacts_of(task).map((artifact) => artifact['artifactId'])).size).toBe(2)
  })

  it('warns on stderr about the steps a gate makes run again, and says nothing when no step does', async () => {
    const written: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    await agent_for({ flow: sequence([speaker('draft', ['x']), approval()]), card: CARD })
    expect(written).toEqual([
      'a2a_agent: release-notes runs these steps again on every answer to a gate, so wrap each in checkpoint(): draft (before approve)\n',
    ])
    await agent_for({ flow: gated_flow(), card: CARD })
    expect(written).toHaveLength(1)
  })
})

describe('a2a_agent: an external gate', () => {
  const external = { gates: (gate: string) => (gate === 'approve' ? 'external' : 'client') } as const

  it('rests WORKING with a note that names the gate, and refuses a message for it', async () => {
    const agent = await agent_for({ flow: gated_flow(), card: CARD, ...external })

    const task = await send(agent, 'v1.2')

    expect(state_of(task)).toBe('TASK_STATE_WORKING')
    expect(status_text(task)).toBe('Waiting on "approve", which this agent\'s clients don\'t answer.')
    expect(status_message(task)['metadata']).toEqual({ fascicle: { gate: 'approve' } })

    const { error } = await call(agent, 'SendMessage', {
      message: user_message('', { task_id: id_of(task), data: { approved: true } }),
    })
    expect(error).toMatchObject({
      code: -32004,
      message: `Task ${id_of(task)} can't take a message: it waits on "approve", which this agent's clients don't answer`,
    })
    expect(history_of(await get_task(agent, id_of(task)))).toHaveLength(history_of(task).length)
  })

  it('completes the task in the store when an outside event resumes it', async () => {
    const runs = fresh_runs()
    const agent = await agent_for({ flow: gated_flow(), card: CARD, runs, ...external })
    const task = await send(agent, 'v1.2')

    await agent.resume(id_of(task), { approve: { approved: true } })

    const done = await get_task(agent, id_of(task))
    expect(state_of(done)).toBe('TASK_STATE_COMPLETED')
    expect(artifact_texts(done)).toEqual(['published: notes on v1.2 [approved]'])
    expect(await runs.get(id_of(task))).toBeUndefined()
  })

  it('reports a run that runs.resume drove directly, at the next GetTask', async () => {
    const runs = fresh_runs()
    const flow = gated_flow()
    const agent = await agent_for({ flow, card: CARD, runs, ...external })
    const task = await send(agent, 'v1.2')

    const outcome = await runs.resume(id_of(task), flow, { approve: { approved: true } }, { install_signal_handlers: false })
    expect(outcome.kind).toBe('done')

    const done = await get_task(agent, id_of(task))
    expect(state_of(done)).toBe('TASK_STATE_COMPLETED')
    expect(artifact_texts(done)).toEqual(['published: notes on v1.2 [approved]'])
    expect(await runs.get(id_of(task))).toBeUndefined()
    expect(artifacts_of(await get_task(agent, id_of(task)))).toHaveLength(1)
  })

  it('moves a task from an external gate to a client gate when the run reaches one', async () => {
    const flow = sequence([approval('ci'), approval('approve')])
    const agent = await agent_for({ flow, card: CARD, gates: (gate) => (gate === 'ci' ? 'external' : 'client') })
    const task = await send(agent, 'build')
    expect(state_of(task)).toBe('TASK_STATE_WORKING')

    await agent.resume(id_of(task), { ci: { approved: true } })

    const asking = await get_task(agent, id_of(task))
    expect(state_of(asking)).toBe('TASK_STATE_INPUT_REQUIRED')
    expect(status_message(asking)['metadata']).toEqual({ fascicle: { gate: 'approve' } })
    const done = await send(agent, '', { task_id: id_of(task), data: { approved: true } })
    expect(artifact_texts(done)).toEqual(['build [approved] [approved]'])
  })

  it('does nothing when asked to resume a task that has ended, and throws for one it cannot find', async () => {
    const agent = await agent_for({ flow: step('echo', (text: string) => text), card: CARD })
    const task = await send(agent, 'hi')
    await expect(agent.resume(id_of(task), { anything: 1 })).resolves.toBeUndefined()
    await expect(agent.resume('no-such-task', {})).rejects.toMatchObject({
      kind: 'a2a_error',
      task_id: 'no-such-task',
      message:
        'no task no-such-task to resume: check the id, and pass `user` when the task belongs to an authenticated caller',
    })
  })
})

describe('a2a_agent: a message the task cannot take', () => {
  it('refuses a message for a working task, and leaves its history as it was', async () => {
    const { flow, latch } = latched()
    const agent = await agent_for({ flow, card: CARD })
    const started = await call(agent, 'SendMessage', {
      message: user_message('go'),
      configuration: { returnImmediately: true },
    })
    const task_id = id_of(task_in(started))
    await latch.started
    const before = history_of(await get_task(agent, task_id))

    const { status, error } = await call(agent, 'SendMessage', { message: user_message('hurry up', { task_id }) })

    expect(status).toBe(200)
    expect(error).toMatchObject({
      code: -32004,
      message: `Task ${task_id} can't take a message: it's working, so wait until it asks for input`,
    })
    expect(history_of(await get_task(agent, task_id))).toEqual(before)

    const streamed = await agent.fetch(
      new Request('http://agent.test/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'SendStreamingMessage',
          params: { message: user_message('hurry up', { task_id }) },
        }),
      }),
    )
    expect(streamed.headers.get('content-type')).toBe('application/json')
    expect(await streamed.json()).toMatchObject({ id: 7, error: { code: -32004 } })

    latch.open()
    await vi.waitFor(async () => {
      expect(state_of(await get_task(agent, task_id))).toBe('TASK_STATE_COMPLETED')
    })
  })

  it('lets the second of two answers to one gate find the task working', async () => {
    const flow = sequence([approval(), latched('publish').flow])
    const agent = await agent_for({ flow, card: CARD })
    const waiting = await send(agent, 'draft')
    const answer = { task_id: id_of(waiting), data: { approved: true } }

    const first = call(agent, 'SendMessage', {
      message: user_message('', answer),
      configuration: { returnImmediately: true },
    })
    const second = call(agent, 'SendMessage', { message: user_message('', answer) })
    const results = await Promise.all([first, second])

    expect(results.filter((result) => result.error !== undefined)).toHaveLength(1)
    expect(results.find((result) => result.error !== undefined)?.error).toMatchObject({ code: -32004 })
  })

  it('refuses a message for a terminal task in the SDK\'s own words', async () => {
    const agent = await agent_for({ flow: step('echo', (text: string) => text), card: CARD })
    const task = await send(agent, 'hi')
    const { error } = await call(agent, 'SendMessage', { message: user_message('again', { task_id: id_of(task) }) })
    expect(error).toMatchObject({ code: -32004 })
    expect(String(error?.['message'])).toContain('terminal state')
  })

  it('answers TaskNotFound for a message that names a task nobody has', async () => {
    const agent = await agent_for({ flow: step('echo', (text: string) => text), card: CARD })
    const { error } = await call(agent, 'SendMessage', { message: user_message('hi', { task_id: 'no-such-task' }) })
    expect(error).toMatchObject({ code: -32001 })
  })

  it('gives the hold back when the SDK refuses an admitted message, so the next answer is taken', async () => {
    const agent = await agent_for({ flow: gated_flow(), card: CARD })
    const waiting = await send(agent, 'v1')
    const task_id = id_of(waiting)

    const mismatched = await call(agent, 'SendMessage', {
      message: user_message('', { task_id, context_id: 'another-context', data: { approved: true } }),
    })
    expect(mismatched.error).toMatchObject({ code: -32602 })

    const done = await send(agent, '', { task_id, data: { approved: true } })
    expect(state_of(done)).toBe('TASK_STATE_COMPLETED')
  })
})

describe('a2a_agent: cancel', () => {
  it('aborts a running task, which ends CANCELED once the flow has seen the abort, and deletes the run', async () => {
    const runs = fresh_runs()
    const { flow, latch } = latched()
    const agent = await agent_for({ flow, card: CARD, runs })
    const started = await call(agent, 'SendMessage', {
      message: user_message('go'),
      configuration: { returnImmediately: true },
    })
    const task_id = id_of(task_in(started))
    await latch.started

    const { result } = await call(agent, 'CancelTask', { id: task_id })

    expect(state_of(result as Json)).toBe('TASK_STATE_CANCELED')
    expect(status_text(result as Json)).toBe('The task was canceled.')
    expect(latch.aborted()).toMatchObject({ kind: 'aborted_error', message: 'the task was canceled' })
    await vi.waitFor(async () => {
      expect(await runs.get(task_id)).toBeUndefined()
    })
    expect(state_of(await get_task(agent, task_id))).toBe('TASK_STATE_CANCELED')
  })

  it('cancels a task whose flow ignores the abort, once the flow has settled', async () => {
    const release = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const flow = step('stubborn', async (text: string) => {
      started.resolve()
      await release.promise
      return `finished anyway: ${text}`
    })
    const agent = await agent_for({ flow, card: CARD })
    const first = await call(agent, 'SendMessage', {
      message: user_message('go'),
      configuration: { returnImmediately: true },
    })
    const task_id = id_of(task_in(first))
    await started.promise

    const canceling = call(agent, 'CancelTask', { id: task_id })
    let settled = false
    void canceling.then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    release.resolve()

    expect(state_of((await canceling).result as Json)).toBe('TASK_STATE_CANCELED')
    expect(artifact_texts(await get_task(agent, task_id))).toEqual([])
  })

  it('cancels a task that waits at a client gate, and deletes the run', async () => {
    const runs = fresh_runs()
    const agent = await agent_for({ flow: gated_flow(), card: CARD, runs })
    const waiting = await send(agent, 'v1')

    const { result } = await call(agent, 'CancelTask', { id: id_of(waiting) })

    expect(state_of(result as Json)).toBe('TASK_STATE_CANCELED')
    expect((result as Json)['contextId']).toBe(waiting['contextId'])
    expect(await runs.get(id_of(waiting))).toBeUndefined()
    const { error } = await call(agent, 'SendMessage', {
      message: user_message('', { task_id: id_of(waiting), data: { approved: true } }),
    })
    expect(error).toMatchObject({ code: -32004 })
  })

  it('cancels after a restart through the SDK\'s own path, and still deletes the run', async () => {
    const store = memory_store()
    const task_store = new InMemoryTaskStore()
    const first = await agent_for({ flow: gated_flow(), card: CARD, runs: durable({ store }), task_store })
    const waiting = await send(first, 'v1')
    await first.close()

    const runs = durable({ store })
    const second = await agent_for({ flow: gated_flow(), card: CARD, runs, task_store })
    expect(await runs.get(id_of(waiting))).toMatchObject({ kind: 'suspended' })

    const { result } = await call(second, 'CancelTask', { id: id_of(waiting) })

    expect(state_of(result as Json)).toBe('TASK_STATE_CANCELED')
    expect(await runs.get(id_of(waiting))).toBeUndefined()
    expect(store.dump()).toEqual({})
  })
})

describe('a2a_agent: stores that outlive the agent', () => {
  function shared_file(): string {
    const dir = mkdtempSync(join(tmpdir(), 'fascicle-a2a-agent-'))
    dirs.push(dir)
    return join(dir, 'agent.db')
  }

  it('takes the answer in a new agent over the same file, and finishes the run', async () => {
    const path = shared_file()
    const before_runs = sqlite_store({ path })
    const before_tasks = sqlite_task_store({ path })
    const first = await agent_for({
      flow: gated_flow(),
      card: CARD,
      runs: durable({ store: before_runs }),
      task_store: before_tasks,
    })
    const waiting = await send(first, 'v1.2')
    expect(state_of(waiting)).toBe('TASK_STATE_INPUT_REQUIRED')
    await first.close()
    before_runs.close()
    before_tasks.close()

    const after_runs = sqlite_store({ path })
    const after_tasks = sqlite_task_store({ path })
    closers.push(after_runs.close, after_tasks.close)
    const runs = durable({ store: after_runs })
    const second = await agent_for({ flow: gated_flow(), card: CARD, runs, task_store: after_tasks })

    expect(state_of(await get_task(second, id_of(waiting)))).toBe('TASK_STATE_INPUT_REQUIRED')
    const done = await send(second, '', { task_id: id_of(waiting), data: { approved: true } })

    expect(state_of(done)).toBe('TASK_STATE_COMPLETED')
    expect(artifact_texts(done)).toEqual(['published: notes on v1.2 [approved]'])
    expect(await runs.get(id_of(waiting))).toBeUndefined()
  })

  it('reports WORKING from a second agent over one store while the first drives', async () => {
    const store = memory_store()
    const task_store = new InMemoryTaskStore()
    const { flow, latch } = latched()
    const first = await agent_for({ flow, card: CARD, runs: durable({ store }), task_store })
    const second = await agent_for({ flow, card: CARD, runs: durable({ store }), task_store })
    const started = await call(first, 'SendMessage', {
      message: user_message('go'),
      configuration: { returnImmediately: true },
    })
    const task_id = id_of(task_in(started))
    await latch.started

    expect(state_of(await get_task(second, task_id))).toBe('TASK_STATE_WORKING')
    const { error } = await call(second, 'SendMessage', { message: user_message('me too', { task_id }) })
    expect(error).toMatchObject({
      code: -32004,
      message: `Task ${task_id} can't take a message: it's working, so wait until it asks for input`,
    })

    latch.open('by the first')
    await vi.waitFor(async () => {
      expect(state_of(await get_task(second, task_id))).toBe('TASK_STATE_COMPLETED')
    })
    expect(artifact_texts(await get_task(second, task_id))).toEqual(['go: by the first'])
  })

  it('keeps a cancel from another agent: the drive runs on, its result is dropped, and its run is deleted', async () => {
    const store = memory_store()
    const task_store = new InMemoryTaskStore()
    const { flow, latch } = latched()
    const runs = durable({ store })
    const driver = await agent_for({ flow, card: CARD, runs, task_store })
    const other = await agent_for({ flow, card: CARD, runs: durable({ store }), task_store })
    const started = await call(driver, 'SendMessage', {
      message: user_message('go'),
      configuration: { returnImmediately: true },
    })
    const task_id = id_of(task_in(started))
    await latch.started

    const canceled = await call(other, 'CancelTask', { id: task_id })
    expect(state_of(canceled.result as Json)).toBe('TASK_STATE_CANCELED')
    // The other agent can't stop a drive it doesn't hold, or delete its run.
    expect(latch.aborted()).toBeUndefined()
    expect(await runs.get(task_id)).toMatchObject({ kind: 'running' })

    latch.open('too late')
    await vi.waitFor(
      async () => {
        expect(await runs.get(task_id)).toBeUndefined()
      },
      { timeout: 5_000 },
    )
    const task = await get_task(driver, task_id)
    expect(state_of(task)).toBe('TASK_STATE_CANCELED')
    expect(artifact_texts(task)).toEqual([])
  }, 10_000)

  it('repairs a task record that fell behind its run: failed, waiting, and working again', async () => {
    const store = memory_store()
    const task_store = new InMemoryTaskStore()
    const flow = sequence([approval('ci'), approval('approve')])
    const runs = durable({ store })
    const agent = await agent_for({
      flow,
      card: CARD,
      runs,
      task_store,
      gates: (gate) => (gate === 'ci' ? 'external' : 'client'),
      to_failure: (err) => `failed: ${(err as Error).message}`,
    })
    const quiet = { install_signal_handlers: false } as const

    const asked = await send(agent, 'build')
    await runs.resume(id_of(asked), flow, { ci: { approved: true } }, quiet)
    const asking = await get_task(agent, id_of(asked))
    expect(state_of(asking)).toBe('TASK_STATE_INPUT_REQUIRED')
    expect(history_of(asking).at(-1)).toMatchObject({ role: 'ROLE_AGENT' })
    expect(history_of(await get_task(agent, id_of(asked)))).toHaveLength(history_of(asking).length)

    // A drive elsewhere took the client's answer: the record reads working.
    const record = (await store.scope(id_of(asked)).get('record')) as Json
    await store.scope(id_of(asked)).set('record', { ...record, status: 'running' })
    const working = await get_task(agent, id_of(asked))
    expect(state_of(working)).toBe('TASK_STATE_WORKING')
    expect((working['status'] as Json)['message']).toBeUndefined()

    await store.scope(id_of(asked)).set('record', { ...record, status: 'failed', error: 'the drive blew up' })
    const failed = await get_task(agent, id_of(asked))
    expect(state_of(failed)).toBe('TASK_STATE_FAILED')
    expect(status_text(failed)).toBe('failed: the drive blew up')
    expect(await runs.get(id_of(asked))).toBeUndefined()
  })
})

describe('a2a_agent: context history', () => {
  it('gives a second task in a context the first task\'s exchange, oldest first', async () => {
    const turns: A2aTurn[] = []
    const agent = await a2a_agent({
      flow: step('echo', (text: string) => `echo: ${text}`),
      card: CARD,
      to_input: (turn) => {
        turns.push(turn)
        return turn.text
      },
    })
    agents.push(agent)

    const first = await send(agent, 'one')
    const context_id = first['contextId'] as string
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = await send(agent, 'two', { context_id })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await send(agent, 'three', { context_id })
    await send(agent, 'elsewhere')

    expect(turns[0]?.history).toEqual([])
    expect(turns[1]?.history).toEqual([
      { task_id: id_of(first), role: 'user', text: 'one' },
      { task_id: id_of(first), role: 'agent', text: 'echo: one' },
    ])
    expect(turns[2]?.history).toEqual([
      { task_id: id_of(first), role: 'user', text: 'one' },
      { task_id: id_of(first), role: 'agent', text: 'echo: one' },
      { task_id: id_of(second), role: 'user', text: 'two' },
      { task_id: id_of(second), role: 'agent', text: 'echo: two' },
    ])
    expect(turns[3]?.history).toEqual([])
  })

  it('reads only the most recent history_limit tasks, and none at zero', async () => {
    const histories: number[] = []
    const build = (history_limit: number) =>
      a2a_agent({
        flow: step('echo', (text: string) => text),
        card: CARD,
        history_limit,
        to_input: (turn) => {
          histories.push(turn.history.length)
          return turn.text
        },
      })
    const limited = await build(1)
    agents.push(limited)
    const first = await send(limited, 'one')
    const context_id = first['contextId'] as string
    await new Promise((resolve) => setTimeout(resolve, 5))
    await send(limited, 'two', { context_id })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await send(limited, 'three', { context_id })
    expect(histories).toEqual([0, 2, 2])

    histories.length = 0
    const none = await build(0)
    agents.push(none)
    const opened = await send(none, 'one')
    await send(none, 'two', { context_id: opened['contextId'] as string })
    expect(histories).toEqual([0, 0])
  })

  it('reads the status message as a task\'s reply when it has no artifact text', async () => {
    const turns: A2aTurn[] = []
    const agent = await a2a_agent({
      flow: approval(),
      card: CARD,
      to_input: (turn) => {
        turns.push(turn)
        return turn.text
      },
    })
    agents.push(agent)
    const waiting = await send(agent, 'draft')
    await send(agent, 'another', { context_id: waiting['contextId'] as string })
    expect(turns[1]?.history).toEqual([
      { task_id: id_of(waiting), role: 'user', text: 'draft' },
      { task_id: id_of(waiting), role: 'agent', text: 'Waiting for input at "approve".' },
    ])
  })
})

describe('a2a_agent: close', () => {
  it('aborts every drive, waits for each to settle, and answers 503 afterwards', async () => {
    const { flow, latch } = latched()
    const agent = await a2a_agent({ flow, card: CARD })
    const started = await call(agent, 'SendMessage', {
      message: user_message('go'),
      configuration: { returnImmediately: true },
    })
    const task_id = id_of(task_in(started))
    await latch.started

    await agent.close()

    expect(latch.aborted()).toMatchObject({
      kind: 'aborted_error',
      message: 'the agent closed while the task was running',
    })
    const response = await agent.fetch(new Request('http://agent.test/.well-known/agent-card.json'))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ message: 'the agent has closed' })
    expect(task_id).toEqual(expect.any(String))
  })

  it('streams text only when the drive asked for chunks, which every drive does', async () => {
    const streaming: boolean[] = []
    const flow = step('probe', (text: string, ctx) => {
      streaming.push(ctx.streaming)
      say(ctx, 'probe', text)
      return text
    })
    const agent = await agent_for({ flow, card: CARD })
    await send(agent, 'hi')
    expect(streaming).toEqual([true])
  })
})
