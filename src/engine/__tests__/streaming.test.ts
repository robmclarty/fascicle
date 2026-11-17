import { describe, expect, it } from 'vitest'
import { create_chunk_dispatcher } from '../streaming.js'
import { on_chunk_error } from '../errors.js'

describe('create_chunk_dispatcher', () => {
  it('is a no-op when on_chunk is undefined', async () => {
    const dispatcher = create_chunk_dispatcher(undefined)
    await dispatcher.dispatch({ kind: 'text', text: 'hi', step_index: 0 })
    expect(dispatcher.aborted()).toBe(false)
  })

  it('invokes on_chunk and records failure on sync throw', async () => {
    const seen: string[] = []
    const dispatcher = create_chunk_dispatcher((chunk) => {
      if (chunk.kind === 'text') {
        if (chunk.text === 'boom') throw new Error('bad')
        seen.push(chunk.text)
      }
    })
    await dispatcher.dispatch({ kind: 'text', text: 'ok', step_index: 0 })
    await expect(
      dispatcher.dispatch({ kind: 'text', text: 'boom', step_index: 0 }),
    ).rejects.toBeInstanceOf(on_chunk_error)
    expect(dispatcher.aborted()).toBe(true)
    // Subsequent dispatch does nothing.
    await dispatcher.dispatch({ kind: 'text', text: 'silent', step_index: 0 })
    expect(seen).toEqual(['ok'])
  })

  it('records failure on a rejected async on_chunk promise', async () => {
    const dispatcher = create_chunk_dispatcher(async () => {
      throw new Error('async boom')
    })
    await expect(
      dispatcher.dispatch({ kind: 'text', text: 'x', step_index: 0 }),
    ).rejects.toBeInstanceOf(on_chunk_error)
    expect(dispatcher.aborted()).toBe(true)
  })
})
