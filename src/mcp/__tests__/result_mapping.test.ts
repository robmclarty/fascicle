import { describe, expect, it } from 'vitest'
import { mcp_error } from '../errors.js'
import { call_result_to_output, output_to_call_result } from '../result_mapping.js'

describe('call_result_to_output', () => {
  it('prefers structuredContent over text', () => {
    const out = call_result_to_output({
      content: [{ type: 'text', text: 'ignored' }],
      structuredContent: { value: 5 },
    })
    expect(out).toEqual({ value: 5 })
  })

  it('joins all text parts when there is no structuredContent', () => {
    const out = call_result_to_output({
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
    })
    expect(out).toBe('line one\nline two')
  })

  it('returns raw content when there are no text parts', () => {
    const content = [{ type: 'image', data: 'abc', mimeType: 'image/png' }]
    expect(call_result_to_output({ content })).toEqual(content)
  })

  it('throws mcp_error when the result is an error', () => {
    expect(() =>
      call_result_to_output(
        { content: [{ type: 'text', text: 'boom' }], isError: true },
        'do_thing',
      ),
    ).toThrow(mcp_error)
    try {
      call_result_to_output({ content: [{ type: 'text', text: 'boom' }], isError: true }, 'do_thing')
    } catch (err) {
      expect(err).toBeInstanceOf(mcp_error)
      expect((err as mcp_error).message).toBe('boom')
      expect((err as mcp_error).tool_name).toBe('do_thing')
    }
  })

  it('tolerates a non-record result', () => {
    expect(call_result_to_output(null)).toBeNull()
  })
})

describe('output_to_call_result', () => {
  it('wraps a string as a single text part', () => {
    expect(output_to_call_result('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] })
  })

  it('emits an object as text plus structuredContent', () => {
    const result = output_to_call_result({ a: 1 })
    expect(result.content).toEqual([{ type: 'text', text: '{"a":1}' }])
    expect(result.structuredContent).toEqual({ a: 1 })
  })

  it('emits an array as text only (no structuredContent)', () => {
    const result = output_to_call_result([1, 2])
    expect(result.content).toEqual([{ type: 'text', text: '[1,2]' }])
    expect(result.structuredContent).toBeUndefined()
  })

  it('stringifies primitives', () => {
    expect(output_to_call_result(42).content[0]?.text).toBe('42')
    expect(output_to_call_result(true).content[0]?.text).toBe('true')
    expect(output_to_call_result(null).content[0]?.text).toBe('null')
  })

  it('honors a custom to_result', () => {
    const result = output_to_call_result(
      { score: 9 },
      (o) => ({ text: `score=${o.score}`, structured: { score: o.score } }),
    )
    expect(result.content).toEqual([{ type: 'text', text: 'score=9' }])
    expect(result.structuredContent).toEqual({ score: 9 })
  })
})
