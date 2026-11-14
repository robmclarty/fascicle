import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { create_transcript } from '../transcript.js'

function chunk(kind: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk', text: string): SessionUpdate {
  return { sessionUpdate: kind, content: { type: 'text', text } }
}

const card: SessionUpdate = { sessionUpdate: 'tool_call', toolCallId: 'card-1', title: 'Run the tests', status: 'pending' }
const card_done: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'card-1', status: 'completed' }

describe('create_transcript', () => {
  it('starts with the prompt, one user chunk for each block, with adjacent text joined', () => {
    const transcript = create_transcript([
      { type: 'text', text: 'look at ' },
      { type: 'text', text: 'this: ' },
      { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' },
      { type: 'text', text: ' please' },
    ])
    expect(transcript.updates()).toEqual([
      chunk('user_message_chunk', 'look at this: '),
      { sessionUpdate: 'user_message_chunk', content: { type: 'resource_link', uri: 'file:///a.ts', name: 'a.ts' } },
      chunk('user_message_chunk', ' please'),
    ])
  })

  it('joins adjacent text chunks of one kind, and keeps kinds apart', () => {
    const transcript = create_transcript([{ type: 'text', text: 'go' }])
    for (const update of [
      chunk('agent_thought_chunk', 'hm'),
      chunk('agent_thought_chunk', 'm'),
      chunk('agent_message_chunk', 'hel'),
      chunk('agent_message_chunk', 'lo'),
      chunk('agent_message_chunk', ''),
    ]) {
      transcript.note(update)
    }
    expect(transcript.updates()).toEqual([
      chunk('user_message_chunk', 'go'),
      chunk('agent_thought_chunk', 'hmm'),
      chunk('agent_message_chunk', 'hello'),
    ])
  })

  it('keeps a tool card and its update as sent, and starts a new chunk after them', () => {
    const transcript = create_transcript([])
    for (const update of [chunk('agent_message_chunk', 'before'), card, card_done, chunk('agent_message_chunk', 'after')]) {
      transcript.note(update)
    }
    expect(transcript.updates()).toEqual([chunk('agent_message_chunk', 'before'), card, card_done, chunk('agent_message_chunk', 'after')])
  })

  it('keeps two chunks apart when anything but their text differs', () => {
    const transcript = create_transcript([])
    const first: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' }, _meta: { part: 1 } }
    const second: SessionUpdate = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'b' }, _meta: { part: 2 } }
    transcript.note(first)
    transcript.note(second)
    transcript.note({ ...second, content: { type: 'text', text: 'c' } })
    expect(transcript.updates()).toEqual([first, { ...second, content: { type: 'text', text: 'bc' } }])
  })

  it('keeps a message that is not text as its own entry', () => {
    const transcript = create_transcript([])
    const picture: SessionUpdate = {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    }
    transcript.note(chunk('agent_message_chunk', 'see'))
    transcript.note(picture)
    transcript.note(picture)
    expect(transcript.updates()).toEqual([chunk('agent_message_chunk', 'see'), picture, picture])
  })

  it("leaves out the session's title, its usage, and a notice", () => {
    const transcript = create_transcript([])
    transcript.note({ sessionUpdate: 'session_info_update', title: 'A title' })
    transcript.note({ sessionUpdate: 'usage_update', used: 1, size: 2 })
    transcript.note({ sessionUpdate: 'notice', severity: 'warning', title: 'A server is down' })
    expect(transcript.updates()).toEqual([])
  })

  it('copies what it keeps, so a later change to an update sent leaves the record alone', () => {
    const transcript = create_transcript([])
    const sent = { sessionUpdate: 'tool_call' as const, toolCallId: 'card-1', title: 'Run', locations: [{ path: '/a' }] }
    transcript.note(sent)
    sent.locations.push({ path: '/b' })
    expect(transcript.updates()).toEqual([{ sessionUpdate: 'tool_call', toolCallId: 'card-1', title: 'Run', locations: [{ path: '/a' }] }])
  })
})
