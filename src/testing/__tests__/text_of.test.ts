import { describe, expect, it } from 'vitest'
import type { Message } from '#engine'
import { text_of } from '../text_of.js'

describe('text_of', () => {
  it('returns a string prompt verbatim', () => {
    expect(text_of({ prompt: 'plain question' })).toBe('plain question')
    expect(text_of({ prompt: '' })).toBe('')
  })

  it('returns the string content of user messages', () => {
    const prompt: Message[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'first ask' },
    ]
    expect(text_of({ prompt })).toBe('first ask')
  })

  it('extracts text parts from user content-part arrays, skipping images', () => {
    const prompt: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', image: 'aGk=', media_type: 'image/png' },
          { type: 'text', text: 'what is it?' },
        ],
      },
    ]
    expect(text_of({ prompt })).toBe('look at this\nwhat is it?')
  })

  it('joins multiple user turns with newlines', () => {
    const prompt: Message[] = [
      { role: 'user', content: 'turn one' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: [{ type: 'text', text: 'turn two' }] },
    ]
    expect(text_of({ prompt })).toBe('turn one\nturn two')
  })

  it('ignores system, assistant, and tool messages', () => {
    const prompt: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: [{ type: 'text', text: 'assistant text' }] },
      { role: 'tool', tool_call_id: 'c1', name: 'lookup', content: 'tool output' },
    ]
    expect(text_of({ prompt })).toBe('')
  })

  it('returns the empty string for an empty message list or textless user turns', () => {
    expect(text_of({ prompt: [] })).toBe('')
    const image_only: Message[] = [
      { role: 'user', content: [{ type: 'image', image: 'aGk=' }] },
    ]
    expect(text_of({ prompt: image_only })).toBe('')
  })
})
